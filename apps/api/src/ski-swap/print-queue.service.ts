import { BadRequestException, ConflictException, GoneException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import type { Device, PrintJob, SwapPrinter } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LabelRendererService } from './printing/label-renderer.service';
import { PrintRecipeService, printTargetFor, type PrintRecipeKind } from './printing/print-recipe.service';
import { geometryOf, type PrintTarget } from './printing/geometry';
import type { HelperLabelData } from './printing/label-templates';
import type { StationPrintKind, StationPrintRequest, StationQueueResponse } from '../contracts/ski-swap.contracts';
import { TelemetryService } from '../telemetry/telemetry.service';

/** How long a claimed job is held before it returns to the queue. */
const CLAIM_SECONDS = 90;
/** Attempts before a job is abandoned rather than retried forever. */
const MAX_ATTEMPTS = 5;
/**
 * Polling cadence hints, in ms.
 *
 * Both are short now that an empty claim is held open rather than answered
 * immediately: the waiting happens inside the request, so a bridge that has
 * just been told "nothing" should come straight back and start waiting again.
 * The old idle value of five seconds was the whole of the lag between a seller
 * pressing print and the printer moving — the work itself takes about 25ms.
 */
const BACKOFF_ACTIVE = 1000;
const BACKOFF_IDLE = 1000;

/**
 * How long an empty claim is held before answering.
 *
 * Bounded by the firmware's 20-second HTTP timeout, with room to spare: a
 * bridge that gives up mid-request would retry work the server thinks is in
 * flight. It also bounds how stale `lastSeenAt` gets while a request is held,
 * which is what the twenty-second offline rule is measured against — ten
 * seconds of holding plus a second of backoff leaves that comfortable.
 */
const HOLD_MS = 10_000;

/**
 * How often a held claim looks again without being told to.
 *
 * The wake-up is in-process, so it only carries within one server. This is the
 * backstop for a job enqueued somewhere that signal cannot reach — a second
 * instance, or a row written directly — and it caps how long that costs.
 */
const RECHECK_MS = 2_000;

export type PrintJobKind =
  | 'item' | 'receipt_header' | 'receipt_items' | 'qr' | 'calibration'
  | 'helper_item' | 'helper_office'
  // Pages the iPad drew and the bridge prints as sent (iOS Plan 26).
  | 'drawn_item_tag' | 'drawn_receipt' | 'drawn_seller_qr' | 'drawn_helper_labels';

/** A drawn job's kind, from what was asked for. Short: the firmware keeps 31 characters. */
const DRAWN_KIND: Record<StationPrintKind, PrintJobKind> = {
  item_tag: 'drawn_item_tag',
  receipt: 'drawn_receipt',
  seller_qr: 'drawn_seller_qr',
  helper_labels: 'drawn_helper_labels',
};

/** What each kind is called in a refusal. */
const PRINT_KIND_NAME: Record<StationPrintKind, string> = {
  item_tag: 'item tags',
  receipt: 'receipts',
  seller_qr: 'QR labels',
  helper_labels: 'helper labels',
};

/** One request's worth of labels, pages times copies: a long receipt twice, with room. */
const STATION_PRINT_MAX_JOBS = 40;

/**
 * How long a helper-label pair may wait for its bridge (Plan 28). They are wanted
 * while the ticket is in the volunteer's hand; a pair a bridge only picks up an
 * hour later is stickers for tickets long since handed over, so it is dropped.
 */
export const HELPER_LABEL_TTL_MS = 60_000;

/** A bridge counts as online within this — the web's offline rule. */
export const BRIDGE_ONLINE_MS = 20_000;

/** The text for a legacy ticket's helper stickers, as the iPad sent it. */
export interface HelperLabelRequest {
  swapId: string;
  itemId?: string | null;
  ticket: string;
  name: string;
  itemName: string;
  size: string | null;
  priceCents: number;
  sellerName: string;
}

/** A refusal the iPad shows after "helper labels didn't print:". */
function helperRefusal(code: string, message: string): ConflictException {
  return new ConflictException({ message, code });
}

export interface ClaimedJob {
  id: string;
  kind: PrintJobKind;
  seq: number;
  /**
   * The rendered raster, base64-encoded. Absent when the claim asked for
   * `payload=omit`: the bridge then fetches the bytes from `raster()`.
   */
  payload?: string;
  /**
   * The raster's length in bytes — exactly what `raster()` returns for this
   * job. A bridge with no room to spare decides from this, before downloading
   * anything, whether it can take the job at all.
   */
  rasterBytes: number;
  /**
   * Bytes per raster row, which is how the bridge knows the label's width.
   *
   * It used to divide the payload by a hard-coded 50 to find the height, so a
   * 62 mm label — 72 bytes a row — was not a whole number of rows and the job
   * was refused before it reached the printer. Bytes rather than dots because
   * that is the value both ends already hold: the `GS v 0` header wants bytes,
   * and a row's length is bytes.
   *
   * Always sent. Firmware that predates it reads 50 and is right about every
   * M110, which is every board in the field today.
   */
  widthBytes: number;
}

/**
 * The print queue.
 *
 * Jobs hold a *recipe* rather than bytes — what to draw and for which item — and
 * the raster is produced when a job is claimed. Rendering is a couple of
 * milliseconds, so paying it per claim costs nothing, and paying it late means a
 * job adapts to whichever printer is attached when it actually prints. Swap a
 * station's Phomemo mid-swap and queued work re-renders for the new geometry
 * instead of carrying bytes baked against the old one.
 */
@Injectable()
export class PrintQueueService {
  /**
   * Claims currently held open, by station, and how to wake each one.
   *
   * In-process on purpose: the alternative is a queue or a channel, and this
   * server is one process serving one venue. `RECHECK_MS` is what makes that
   * assumption safe to be wrong about rather than something to be right about.
   */
  private readonly waiting = new Map<string, Set<() => void>>();

  /**
   * Each claimed job's raster, kept for the life of its claim.
   *
   * A job holds a recipe, not bytes, and is rendered when claimed. A bridge
   * that fetches the raster separately (`raster()`) may fetch it more than
   * once — a TLS session drops mid-body — and every fetch has to be the same
   * bytes the claim promised by length. Rendering again would usually agree,
   * but an item edited or a printer swapped between the two would not, so the
   * claim's own render is kept and served.
   *
   * In memory, like `waiting`: production is one process. After a restart a
   * live claim is rendered again; if that disagrees with the length the claim
   * gave, the bridge sees a mismatch and nacks, which is the safe failure.
   */
  private readonly rasters = new Map<string, { claimToken: string; bytes: Buffer; until: number }>();

  private keepRaster(jobId: string, claimToken: string, bytes: Buffer): void {
    const now = Date.now();
    for (const [id, kept] of this.rasters) if (kept.until < now) this.rasters.delete(id);
    this.rasters.set(jobId, { claimToken, bytes, until: now + CLAIM_SECONDS * 1000 });
  }

  /** Tells anything holding a claim for this station to look again now. */
  private wake(stationId: string): void {
    const listeners = this.waiting.get(stationId);
    if (!listeners) return;
    for (const notify of [...listeners]) notify();
  }

  /**
   * Resolves when work is signalled for any of these stations, or after `ms`.
   *
   * Several, because a bridge may print for several staffed stations (Plan 27)
   * and an enqueue at any one of them is work for it.
   */
  private waitForWork(stationIds: string[], ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const stationId of stationIds) {
          const listeners = this.waiting.get(stationId);
          listeners?.delete(finish);
          if (listeners?.size === 0) this.waiting.delete(stationId);
        }
        resolve();
      };
      const timer = setTimeout(finish, ms);
      for (const stationId of stationIds) {
        const listeners = this.waiting.get(stationId) ?? new Set<() => void>();
        this.waiting.set(stationId, listeners);
        listeners.add(finish);
      }
    });
  }

  private readonly logger = new Logger(PrintQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: LabelRendererService,
    private readonly recipes: PrintRecipeService,
    private readonly telemetry: TelemetryService,
  ) {}

  // ─── Enqueue ────────────────────────────────────────────────────────────────

  /**
   * Queues `count` tags for an item. Refuses when live jobs already exist for
   * it, so an edit cannot produce a second tag with no home — the guard is the
   * queue rather than `hasPrintedTag`, which stays false until paper comes out.
   */
  async enqueueItemTags(params: {
    orgId: string;
    stationId: string;
    swapId: string;
    sellerId: string | null;
    itemId: string;
    count: number;
  }): Promise<number> {
    const existing = await this.prisma.printJob.count({
      where: { itemId: params.itemId, status: { in: ['queued', 'claimed', 'printed'] } },
    });
    if (existing > 0) return 0;

    const station = await this.station(params.orgId, params.stationId);
    // Queued as a side effect of saving an item, so it is skipped rather than
    // refused: the item matters more than its tag, and it stays untagged
    // (`hasPrintedTag: false`) for printing somewhere that can.
    if (this.helperOnly(station)) return 0;
    await this.prisma.printJob.createMany({
      data: Array.from({ length: params.count }, (_, i) => ({
        id: createId(),
        orgId: params.orgId,
        stationId: station.id,
        printerId: station.bridge?.bridgedPrinter?.id ?? null,
        swapId: params.swapId,
        sellerId: params.sellerId,
        itemId: params.itemId,
        kind: 'item',
        seq: i,
      })),
    });
    this.wake(station.id);
    return params.count;
  }

  /** Re-queues one item's tags. The only path that deliberately prints twice. */
  async reprintItem(orgId: string, stationId: string, itemId: string): Promise<void> {
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Item not found');

    const station = await this.station(orgId, stationId);
    // Asked for by someone, so they are told why not.
    if (this.helperOnly(station)) throw this.stockRefusal(station.name);
    await this.prisma.printJob.create({
      data: {
        id: createId(),
        orgId,
        stationId: station.id,
        printerId: station.bridge?.bridgedPrinter?.id ?? null,
        swapId: item.swapId,
        sellerId: item.sellerId,
        itemId: item.id,
        kind: 'item',
        seq: 0,
      },
    });
    this.wake(station.id);
  }

  /**
   * Queues a seller's receipt.
   *
   * The compact tier prints a masthead label and then a page per batch of line
   * items. The tall tier fits the masthead onto page one, so it has no separate
   * header job and `withHeader` is false — see `drawTallReceipt`.
   */
  async enqueueReceipt(params: {
    orgId: string;
    stationId: string;
    swapId: string;
    sellerId: string;
    pageCount: number;
    withHeader: boolean;
  }): Promise<void> {
    const station = await this.station(params.orgId, params.stationId);
    // A side effect of finishing a check-in: skipped, never refused. The
    // emailed receipt still goes.
    if (this.helperOnly(station)) return;
    const base = {
      orgId: params.orgId,
      stationId: station.id,
      printerId: station.bridge?.bridgedPrinter?.id ?? null,
      swapId: params.swapId,
      sellerId: params.sellerId,
    };
    const headerJobs = params.withHeader
      ? [{ ...base, id: createId(), kind: 'receipt_header', seq: 0 }]
      : [];
    await this.prisma.printJob.createMany({
      data: [
        ...headerJobs,
        ...Array.from({ length: params.pageCount }, (_, i) => ({
          ...base,
          id: createId(),
          kind: 'receipt_items',
          params: { page: i } as Prisma.InputJsonValue,
          seq: headerJobs.length + i,
        })),
      ],
    });
    this.wake(station.id);
  }

  /** Exercises the whole chain: server, bridge, BLE link, printer. */
  async enqueueCalibration(orgId: string, stationId: string): Promise<void> {
    const station = await this.station(orgId, stationId);
    // A helper-only bridge cannot print a calibration label, so its test is a
    // sample pair of helper stickers — still the whole chain, end to end.
    if (this.helperOnly(station)) {
      await this.queueHelperPair(orgId, station.id, station.bridge?.bridgedPrinter?.id ?? null, {
        swapId: null, itemId: null,
        content: {
          ticket: 'TEST', name: 'Test sticker 176cm', itemName: 'Test sticker', size: '176cm',
          priceCents: 4500, sellerName: station.name,
        },
      });
      return;
    }
    await this.prisma.printJob.create({
      data: {
        id: createId(),
        orgId,
        stationId: station.id,
        printerId: station.bridge?.bridgedPrinter?.id ?? null,
        kind: 'calibration',
        seq: 0,
      },
    });
    this.wake(station.id);
  }

  /**
   * A legacy ticket's helper stickers, printed now through the station's bridge
   * (Plan 28), for an iPad with no 25 × 67 printer of its own.
   *
   * Everything is checked before anything is queued, so the answer comes back
   * while the volunteer is at the counter. Success means the bridge is online,
   * its printer is online, and the pair is queued; a pair its bridge does not
   * pick up within a minute is dropped rather than printed late.
   *
   * Only the tablet bound to this station may ask. The text is taken as sent:
   * it is what the iPad would have printed itself, so the two printers agree
   * word for word.
   */
  async printHelperLabels(
    deviceId: string,
    orgId: string,
    stationId: string,
    request: HelperLabelRequest,
  ): Promise<{ jobIds: string[]; notAfter: string }> {
    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId, deletedAt: null, attendantDeviceId: deviceId },
      include: { bridge: { include: { bridgedPrinter: true } } },
    });
    if (!station) throw new NotFoundException('Station not found');

    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: request.swapId, orgId },
      select: { printLegacyHelperLabels: true },
    });
    if (!swap?.printLegacyHelperLabels) {
      throw helperRefusal('HELPER_LABELS_OFF', 'this swap does not print helper labels.');
    }

    const { bridge, printer } = this.reachableBridge(station);
    if (!this.helperOnly(station)) {
      throw helperRefusal('PRINTER_STOCK', `the printer at ${station.name} isn't loaded with 25 × 67 labels.`);
    }
    this.assertPrinterReady(station, bridge);

    // An item the iPad has not synced yet is still a ticket in someone's hand,
    // so a missing one is recorded as absent rather than refused.
    const item = request.itemId
      ? await this.prisma.swapItem.findFirst({ where: { id: request.itemId, orgId, deletedAt: null }, select: { id: true } })
      : null;

    return this.queueHelperPair(orgId, station.id, printer.id, {
      swapId: request.swapId,
      itemId: item?.id ?? null,
      content: {
        ticket: request.ticket, name: request.name, itemName: request.itemName, size: request.size,
        priceCents: request.priceCents, sellerName: request.sellerName,
      },
    });
  }

  /** The pair, as one batch that expires together. */
  private async queueHelperPair(
    orgId: string,
    stationId: string,
    printerId: string | null,
    job: { swapId: string | null; itemId: string | null; content: Omit<HelperLabelRequest, 'swapId' | 'itemId'> },
  ): Promise<{ jobIds: string[]; notAfter: string }> {
    const notAfter = new Date(Date.now() + HELPER_LABEL_TTL_MS);
    const jobIds = [createId(), createId()];
    await this.prisma.printJob.createMany({
      data: (['helper_item', 'helper_office'] as const).map((kind, i) => ({
        id: jobIds[i],
        orgId,
        stationId,
        printerId,
        swapId: job.swapId,
        itemId: job.itemId,
        kind,
        params: job.content as unknown as Prisma.InputJsonValue,
        seq: i,
        notAfter,
      })),
    });
    this.wake(stationId);
    return { jobIds, notAfter: notAfter.toISOString() };
  }

  /**
   * Labels the iPad drew itself, printed through its station's bridge exactly
   * as sent (iOS Plan 26): item tags, receipts, QR labels and helper labels.
   *
   * The iPad draws with a line-for-line port of this server's renderer, for
   * the bridge printer's model and stock, so the two printers' output is the
   * same and a print needs nothing to have synced first. Everything is checked
   * before anything is queued, as for helper labels; each refusal is a 409
   * with a code and a sentence that follows "didn't print: ". A raster drawn
   * for settings the printer no longer has is refused rather than printed at
   * the wrong size. What the bridge hasn't taken within a minute is dropped.
   */
  async printDrawn(
    deviceId: string,
    orgId: string,
    stationId: string,
    request: StationPrintRequest,
  ): Promise<{ jobIds: string[]; notAfter: string }> {
    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId, deletedAt: null, attendantDeviceId: deviceId },
      include: { bridge: { include: { bridgedPrinter: true } } },
    });
    if (!station) throw new NotFoundException('Station not found');

    // Malformed before anything about the counter: a bad request is the
    // iPad's to fix, whatever state the bridge is in.
    const bytesPerPage = (request.widthDots / 8) * request.heightDots;
    const pages = request.pages.map((page, i) => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(page)) throw new BadRequestException(`Page ${i + 1} is not base64.`);
      const bytes = Buffer.from(page, 'base64');
      if (bytes.length !== bytesPerPage) {
        throw new BadRequestException(
          `Page ${i + 1} is ${bytes.length} bytes; ${request.widthDots} × ${request.heightDots} dots packs to ${bytesPerPage}.`,
        );
      }
      return bytes;
    });
    if (pages.length * request.copies > STATION_PRINT_MAX_JOBS) {
      throw new BadRequestException(`That is ${pages.length * request.copies} labels; one request prints at most ${STATION_PRINT_MAX_JOBS}.`);
    }

    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: request.swapId, orgId },
      select: { legacyTicketsOnly: true, printLegacyHelperLabels: true },
    });
    if (!swap) throw new NotFoundException('Swap not found');
    if (request.kind === 'item_tag' && swap.legacyTicketsOnly) {
      throw helperRefusal('TAGS_OFF', 'this swap uses legacy tickets, so it prints no item tags.');
    }
    if (request.kind === 'helper_labels' && !swap.printLegacyHelperLabels) {
      throw helperRefusal('HELPER_LABELS_OFF', 'this swap does not print helper labels.');
    }

    const { bridge, printer } = this.reachableBridge(station);

    const target = printTargetFor(printer);
    const tier = target.size.tier;
    const stockTakes =
      request.kind === 'item_tag' ? tier === 'compact' || tier === 'tall'
      : request.kind === 'helper_labels' ? tier === 'strip'
      : tier !== 'strip';
    if (!stockTakes) {
      throw helperRefusal(
        'PRINTER_STOCK',
        `the printer at ${station.name} is loaded with ${target.size.label} labels, which don't take ${PRINT_KIND_NAME[request.kind]}.`,
      );
    }
    if (!drawnFor(target, printer, request)) {
      throw helperRefusal(
        'PRINTER_STOCK',
        `the printer at ${station.name} has been set up differently since this iPad last synced. Sync and try again.`,
      );
    }
    this.assertPrinterReady(station, bridge);

    // For the record. Only a tag is tied to its item: acknowledging a job with
    // an item marks that item's tag printed, which a receipt must not do.
    const [item, seller] = await Promise.all([
      request.kind === 'item_tag' && request.itemId
        ? this.prisma.swapItem.findFirst({ where: { id: request.itemId, orgId, deletedAt: null }, select: { id: true } })
        : null,
      request.sellerId
        ? this.prisma.sellerProfile.findFirst({ where: { id: request.sellerId, membership: { orgId } }, select: { id: true } })
        : null,
    ]);

    const notAfter = new Date(Date.now() + HELPER_LABEL_TTL_MS);
    const kind = DRAWN_KIND[request.kind];
    const rows = Array.from({ length: request.copies }, (_, copy) =>
      pages.map((raster, page) => ({
        id: createId(),
        orgId,
        stationId: station.id,
        printerId: printer.id,
        swapId: request.swapId,
        itemId: item?.id ?? null,
        sellerId: seller?.id ?? null,
        kind,
        params: {
          page, copy, model: request.model, paperSize: request.paperSize,
          widthDots: request.widthDots, heightDots: request.heightDots,
          ...(request.itemId && !item ? { unsyncedItemId: request.itemId } : {}),
        } as Prisma.InputJsonValue,
        raster,
        notAfter,
      })),
    ).flat().map((row, seq) => ({ ...row, seq }));

    await this.prisma.printJob.createMany({ data: rows });
    this.wake(station.id);
    return { jobIds: rows.map((r) => r.id), notAfter: notAfter.toISOString() };
  }

  /**
   * The station's bridge and its printer, when both can be reached: a bridge
   * that has checked in within the offline rule's 20 seconds, driving a printer.
   */
  private reachableBridge(
    station: { name: string; bridge: (Device & { bridgedPrinter: SwapPrinter | null }) | null },
  ): { bridge: Device & { bridgedPrinter: SwapPrinter | null }; printer: SwapPrinter } {
    const bridge = station.bridge;
    if (!bridge) {
      throw helperRefusal('NO_BRIDGE', `${station.name} has no print bridge.`);
    }
    if (!bridge.lastSeenAt || Date.now() - bridge.lastSeenAt.getTime() > BRIDGE_ONLINE_MS) {
      throw helperRefusal('BRIDGE_OFFLINE', `the print bridge at ${station.name} is offline.`);
    }
    const printer = bridge.bridgedPrinter;
    if (!printer) {
      throw helperRefusal('NO_PRINTER', `the print bridge at ${station.name} has no printer.`);
    }
    return { bridge, printer };
  }

  /** Online is a report of `ready`. A printer never reported, or reported down, is not known to be able to print. */
  private assertPrinterReady(station: { name: string }, bridge: { printerLink: string | null }): void {
    if (bridge.printerLink !== 'ready') {
      throw helperRefusal('PRINTER_OFFLINE', `the printer at ${station.name} is offline.`);
    }
  }

  // ─── Claim / ack / nack ─────────────────────────────────────────────────────

  /**
   * Claims up to `limit` jobs for the station this device is bound to.
   *
   * The claim is a single atomic UPDATE rather than read-then-write: two bridges
   * racing — which happens for a moment during a re-bind — or one whose earlier
   * claim expired mid-print must not both win the same row. Expired claims are
   * swept by the same statement, so an idle system does no work and a busy one
   * self-heals.
   */
  async claim(
    deviceId: string,
    limit = 4,
    printerLink?: 'ready' | 'down',
    /**
     * What the bridge says about its scanner, if it has one. Travels with the
     * printer report for the same reason that one does: it costs no extra
     * request on venue wifi.
     */
    scanner?: {
      link?: 'ready' | 'down';
      battery?: number;
      queueDepth?: number;
    },
    /**
     * The live response, so an empty claim can be held open until work arrives
     * and dropped the moment the bridge hangs up. Absent in tests and scripts,
     * where answering immediately is what is wanted.
     *
     * The response rather than the request: Node destroys a request stream once
     * its body has been read, so a claim that had been parsed already looked
     * disconnected and the hold ended after a single re-check.
     */
    res?: { on: (e: string, f: () => void) => void; off: (e: string, f: () => void) => void },
    /**
     * How long the caller is willing to have this request held, in ms, capped
     * at `HOLD_MS`. The client owns its own HTTP timeout, so it is the only
     * party that can say — and a caller that wants an answer now, like a
     * diagnostic or a test, asks for zero.
     */
    holdMs = HOLD_MS,
    /**
     * `omitPayload` leaves the base64 out of the response. A bridge with no
     * PSRAM cannot hold a 62 × 100 label as base64 inside JSON — ~75 KB against
     * a largest free block of 72 KB — so it takes the size here and the bytes
     * from `raster()`.
     */
    options: { omitPayload?: boolean } = {},
  ): Promise<{
    /** The first of `stationIds` by name. Kept for firmware that shows it. */
    stationId: string;
    /** Every station this bridge prints for (Plan 27). */
    stationIds: string[];
    backoffMs: number;
    jobs: ClaimedJob[];
    printer: { bluetoothName: string } | null;
    scanner: { bluetoothName: string } | null;
  }> {
    // Before the station lookup, because a bridge that is calling in is alive
    // and telling us about its printer whether or not anything routes work to
    // it. Recording this after the 404 meant an unbound bridge could never
    // report its printer link at all, and one sitting there connected to a
    // printer read "printer unconfirmed" indefinitely.
    // When it was seen before this, so a long enough gap can be recorded as
    // an outage once we know whether it serves a station.
    const seenBefore = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { lastSeenAt: true },
    });
    const now = new Date();
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: now,
        // Only when reported. A bridge that says nothing leaves the previous
        // answer standing, and its age is what makes it readable.
        ...(printerLink ? { printerLink, printerLinkAt: new Date() } : {}),
        ...(scanner?.link ? { scannerLink: scanner.link, scannerLinkAt: new Date() } : {}),
        ...(scanner?.battery !== undefined ? { scannerBattery: scanner.battery } : {}),
        ...(scanner?.queueDepth !== undefined ? { scanQueueDepth: scanner.queueDepth } : {}),
      },
    });

    /*
     * Every station this bridge prints for. One, usually; several when staffed
     * counters share it (Plan 27). Its printer and scanner are the bridge's
     * own, whichever station a job came from.
     */
    const bridge = await this.prisma.device.findUniqueOrThrow({
      where: { id: deviceId },
      include: {
        bridgedPrinter: true,
        bridgedScanner: true,
        bridgedStations: { where: { deletedAt: null }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } },
      },
    });
    const stations = bridge.bridgedStations;
    const stationIds = stations.map((s) => s.id);
    const codeOf = new Map(stations.map((s) => [s.id, s.code]));
    // Best-effort: a claim must never fail over bookkeeping about the bridge.
    await this.telemetry
      .recordCheckIn(deviceId, seenBefore?.lastSeenAt ?? null, now, stations.length > 0)
      .catch((err) => this.logger.error({ err, deviceId }, 'Could not record a bridge outage'));
    if (stations.length === 0) throw new NotFoundException('This device is not bound to a station');

    /**
     * What this bridge should be holding, on every claim.
     *
     * The server has always known this and never said it, so changing which
     * printer a bridge drives meant walking to the board and re-provisioning it
     * over BLE. Null is a real answer — "drop what you are holding" — which is
     * why these are always present rather than omitted when empty.
     */
    const peripherals = {
      printer: bridge.bridgedPrinter ? { bluetoothName: bridge.bridgedPrinter.bluetoothName } : null,
      scanner: bridge.bridgedScanner ? { bluetoothName: bridge.bridgedScanner.bluetoothName } : null,
    };

    // Give up on expired claims that have already had their attempts.
    //
    // Without this the sweep below re-claims them forever: a bridge that dies
    // mid-print never acks and never nacks, so nothing ever moves the job past
    // `claimed`, and the only path to `abandoned` — nack — is never taken. One
    // job that hangs a printer would block its station for the rest of the swap.
    const abandoned = await this.prisma.$executeRaw`
      UPDATE PrintJob
         SET status = 'abandoned',
             raster = NULL,
             claimToken = NULL,
             claimUntil = NULL,
             lastError = COALESCE(lastError, 'Claimed but never acknowledged'),
             updatedAt = NOW(3)
       WHERE stationId IN (${Prisma.join(stationIds)})
         AND status = 'claimed'
         AND claimUntil < NOW(3)
         AND attempts >= ${MAX_ATTEMPTS}`;
    if (abandoned > 0) {
      this.logger.warn(
        { stationIds, abandoned },
        'Abandoned print jobs that were claimed but never acknowledged',
      );
    }

    // Drop what was wanted at the counter and not printed in time (Plan 28):
    // queued, or claimed by a bridge that never came back, past its `notAfter`.
    const expired = await this.prisma.$executeRaw`
      UPDATE PrintJob
         SET status = 'abandoned',
             raster = NULL,
             claimToken = NULL,
             claimUntil = NULL,
             lastError = 'Not printed within a minute of being asked for',
             updatedAt = NOW(3)
       WHERE stationId IN (${Prisma.join(stationIds)})
         AND notAfter IS NOT NULL
         AND notAfter < NOW(3)
         AND (status = 'queued' OR (status = 'claimed' AND claimUntil < NOW(3)))`;
    if (expired > 0) {
      this.logger.warn({ stationIds, expired }, 'Dropped helper labels that were not printed in time');
    }

    const token = createId();
    const take = async (): Promise<PrintJob[]> => {
      if (limit === 0) return [];
      await this.prisma.$executeRaw`
        UPDATE PrintJob
           SET status = 'claimed',
               claimToken = ${token},
               claimedAt = NOW(3),
               claimUntil = DATE_ADD(NOW(3), INTERVAL ${CLAIM_SECONDS} SECOND),
               attempts = attempts + 1
         WHERE stationId IN (${Prisma.join(stationIds)})
           AND attempts < ${MAX_ATTEMPTS}
           AND (notAfter IS NULL OR notAfter >= NOW(3))
           AND (status = 'queued' OR (status = 'claimed' AND claimUntil < NOW(3)))
         ORDER BY createdAt, seq
         LIMIT ${limit}`;
      return this.prisma.printJob.findMany({
        where: { claimToken: token },
        orderBy: [{ createdAt: 'asc' }, { seq: 'asc' }],
      });
    };

    /*
     * First queued, first printed, each batch whole (Plan 27).
     *
     * A batch is written by one `createMany`, and MySQL gives every row of one
     * statement the same NOW(3), so ordering by time and then `seq` keeps each
     * batch together and in its own order. It used to be `seq` first, which
     * put every batch's first job ahead of any batch's second — harmless with
     * one busy counter, and an interleaved pile of tags with several.
     */

    // Hold the request rather than answering "nothing" straight away.
    //
    // The seller is standing at the printer. Answering immediately means the
    // next chance to send them a tag is a whole backoff away, and that gap was
    // the entire wait: the work itself takes about 25ms. Holding costs an idle
    // socket and pays it back as a tag that starts printing as the item saves.
    //
    // Heartbeats are never held. `limit=0` is how a bridge says it is alive and
    // reports its printer link, and blocking it would make both stale.
    let claimed = await take();
    const hold = Math.max(0, Math.min(holdMs, HOLD_MS));

    // Never hold a bridge that still owes us an acknowledgement.
    //
    // The firmware sends acks at the top of its loop, just before it claims, so
    // an ack can only leave between requests. Parking a mid-print bridge in a
    // ten-second hold therefore sits on the very message that says the paper
    // came out, and the seller watches a spinner for a print that finished.
    // While work is outstanding the bridge is busy anyway; holding buys it
    // nothing and costs the confirmation.
    const outstanding =
      claimed.length > 0
        ? 1
        : await this.prisma.printJob.count({
            where: { stationId: { in: stationIds }, status: 'claimed' },
          });

    if (claimed.length === 0 && outstanding === 0 && limit > 0 && res && hold > 0) {
      let clientGone = false;
      const onClose = () => { clientGone = true; stationIds.forEach((id) => this.wake(id)); };
      res.on('close', onClose);
      try {
        const deadline = Date.now() + hold;
        while (claimed.length === 0 && !clientGone && Date.now() < deadline) {
          await this.waitForWork(stationIds, Math.min(RECHECK_MS, deadline - Date.now()));
          if (clientGone) break;
          claimed = await take();
        }
      } finally {
        res.off('close', onClose);
      }
    }

    // Rendering happens after the claim has committed, never inside it: holding
    // write locks across a canvas render would serialise stations against each
    // other for no reason.
    const target = printTargetFor(bridge.bridgedPrinter ?? null);
    const jobs: ClaimedJob[] = [];
    for (const job of claimed) {
      try {
        const { raster, widthBytes } = await this.rasterFor(job, target, codeOf.get(job.stationId) ?? null, bridge.bridgedPrinter ?? null);
        this.keepRaster(job.id, token, raster);
        jobs.push({
          id: job.id,
          kind: job.kind as PrintJobKind,
          seq: job.seq,
          ...(options.omitPayload ? {} : { payload: raster.toString('base64') }),
          rasterBytes: raster.length,
          widthBytes,
        });
      } catch (err) {
        // Nobody is watching a claim the way a seller watches a save, so a
        // recipe that no longer resolves fails once, visibly, instead of
        // retrying until it is abandoned.
        const message = err instanceof Error ? err.message : 'Render failed';
        this.logger.error({ err, jobId: job.id }, 'Print job render failed');
        await this.prisma.printJob.update({
          where: { id: job.id },
          data: { status: 'failed', lastError: message.slice(0, 500), raster: null },
        });
      }
    }

    return {
      stationId: stationIds[0],
      stationIds,
      backoffMs: jobs.length ? BACKOFF_ACTIVE : BACKOFF_IDLE,
      jobs,
      ...peripherals,
    };
  }

  /**
   * Marks a job printed, and flips the item's `hasPrintedTag` once none of its
   * jobs remain unprinted — the flag means paper came out, so only the printer
   * can report it, and only when every tag for that item has emerged.
   */
  async ack(deviceId: string, jobId: string): Promise<void> {
    const job = await this.ownedJob(deviceId, jobId);
    this.rasters.delete(job.id);
    if (job.status === 'printed') return; // idempotent: a retried ack is safe

    await this.prisma.printJob.update({
      where: { id: job.id },
      // A drawn page has done its job; kept, every tag would sit in the database twice.
      data: { status: 'printed', printedAt: new Date(), claimToken: null, raster: null },
    });

    if (job.itemId) {
      const outstanding = await this.prisma.printJob.count({
        where: { itemId: job.itemId, status: { notIn: ['printed', 'abandoned'] } },
      });
      if (outstanding === 0) {
        await this.prisma.swapItem.update({
          where: { id: job.itemId },
          data: { hasPrintedTag: true },
        });
      }
    }
  }

  /** Returns a job to the queue, or abandons it once it has failed enough. */
  async nack(deviceId: string, jobId: string, error?: string): Promise<void> {
    const job = await this.ownedJob(deviceId, jobId);
    this.rasters.delete(job.id);
    const abandon = job.attempts >= MAX_ATTEMPTS;
    await this.prisma.printJob.update({
      where: { id: job.id },
      data: {
        status: abandon ? 'abandoned' : 'queued',
        claimToken: null,
        claimUntil: null,
        lastError: error?.slice(0, 500) ?? null,
      },
    });
  }

  /**
   * A claimed job's raster, as the bytes themselves.
   *
   * For a bridge that cannot hold the raster as base64 inside a claim. Only the
   * bridge holding the claim may fetch it, and only while the claim is live;
   * fetching changes nothing — not the job, not its attempts, not the lease —
   * and every fetch within one claim returns the same bytes.
   *
   * 404 for a job that does not exist, is not on this bridge's station, or was
   * never claimed: which of those it was is nobody's business. 410 for a claim
   * that has expired or been settled, which tells the bridge to drop the job
   * rather than retry.
   */
  async raster(deviceId: string, jobId: string): Promise<Buffer> {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, station: { bridgeDeviceId: deviceId, deletedAt: null } },
      include: { station: { include: { bridge: { include: { bridgedPrinter: true } } } } },
    });
    if (!job || !job.claimedAt) throw new NotFoundException('Job not found for this device');

    const live = job.status === 'claimed' && !!job.claimToken && !!job.claimUntil && job.claimUntil > new Date();
    if (!live) throw new GoneException('This job is no longer claimed');

    const kept = this.rasters.get(job.id);
    if (kept && kept.claimToken === job.claimToken) return kept.bytes;

    // Claimed before a restart. Rendered again and kept, so the next fetch in
    // this claim is the same bytes as this one.
    const printer = job.station.bridge?.bridgedPrinter ?? null;
    const { raster } = await this.rasterFor(job, printTargetFor(printer), job.station.code, printer);
    this.keepRaster(job.id, job.claimToken!, raster);
    return raster;
  }

  // ─── Staff view ─────────────────────────────────────────────────────────────

  /**
   * Enough to tell a busy station from a stuck one without reading logs.
   *
   * `deviceLastSeenAt` is the load-bearing field: a bridge polls about once a
   * second, so depth alone says nothing — work queued behind a *silent* bridge
   * is the failure, and work queued behind a working one is just a busy counter.
   */
  async stationQueue(orgId: string, stationId: string): Promise<StationQueueResponse> {
    const station = await this.station(orgId, stationId);
    const [queued, claimed, failed, abandoned, lastAbandoned, oldest, bridge, attendant] = await Promise.all([
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'queued' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'claimed' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'failed' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'abandoned' } }),
      this.prisma.printJob.findFirst({
        where: { stationId: station.id, status: 'abandoned' },
        orderBy: { updatedAt: 'desc' },
        select: { lastError: true },
      }),
      this.prisma.printJob.findFirst({
        where: { stationId: station.id, status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      station.bridgeDeviceId
        ? this.prisma.device.findUnique({
            where: { id: station.bridgeDeviceId },
            select: {
              lastSeenAt: true, printerLink: true, printerLinkAt: true,
              bridgedStations: { where: { deletedAt: null, id: { not: station.id } }, select: { name: true }, orderBy: { name: 'asc' } },
            },
          })
        : null,
      station.attendantDeviceId
        ? this.prisma.device.findUnique({
            where: { id: station.attendantDeviceId },
            select: { lastSeenAt: true },
          })
        : null,
    ]);

    return {
      stationId: station.id,
      queued,
      claimed,
      failed,
      abandoned,
      lastAbandonedReason: lastAbandoned ? lastAbandoned.lastError ?? 'Gave up after repeated tries' : null,
      oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
      bridgeLastSeenAt: bridge?.lastSeenAt?.toISOString() ?? null,
      attendantLastSeenAt: attendant?.lastSeenAt?.toISOString() ?? null,
      printerLink: (bridge?.printerLink as 'ready' | 'down' | null) ?? null,
      printerLinkAt: bridge?.printerLinkAt?.toISOString() ?? null,
      // The other counters printing through the same bridge (Plan 27): their
      // tags come out of the same printer, in the order they were queued.
      bridgeSharedWith: bridge?.bridgedStations.map((s) => s.name) ?? [],
    };
  }

  async clearQueue(orgId: string, stationId: string): Promise<number> {
    const station = await this.station(orgId, stationId);
    const { count } = await this.prisma.printJob.deleteMany({
      where: { stationId: station.id, status: { in: ['queued', 'failed', 'abandoned'] } },
    });
    return count;
  }

  // ─── Internals ──────────────────────────────────────────────────────────────

  private async station(orgId: string, stationId: string) {
    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId, deletedAt: null },
      // The printer hangs off the bridge: a station reaches it through the box
      // that drives it, so there is one place recording which printer is where.
      include: { bridge: { include: { bridgedPrinter: true } } },
    });
    if (!station) throw new NotFoundException('Station not found');
    return station;
  }

  /**
   * Whether a station's bridge prints helper labels only: its printer holds
   * 25 × 67 (Plan 28). Such a bridge takes nothing else.
   */
  private helperOnly(station: { bridge?: { bridgedPrinter?: { model: string; paperSize: string; marginTop: number; marginBottom: number; marginLeft: number; marginRight: number } | null } | null }): boolean {
    const printer = station.bridge?.bridgedPrinter;
    return !!printer && printTargetFor(printer).size.tier === 'strip';
  }

  private stockRefusal(stationName: string): ConflictException {
    return helperRefusal(
      'PRINTER_STOCK',
      `${stationName}'s printer is loaded with 25 × 67 helper labels, and prints nothing else.`,
    );
  }

  private async ownedJob(deviceId: string, jobId: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, station: { bridgeDeviceId: deviceId } },
    });
    // Scoped through the binding, so a bridge can only ever touch its own work.
    if (!job) throw new NotFoundException('Job not found for this device');
    return job;
  }

  /**
   * The bytes the bridge prints for one job, packed, and how wide each row is.
   *
   * A page the iPad drew is printed as sent, once it is checked against the
   * printer as it is now: one re-set to other stock since the request would
   * print it at the wrong size, so it fails rather than prints. Everything else
   * is rendered here.
   */
  private async rasterFor(
    job: { orgId: string; kind: string; itemId: string | null; sellerId: string | null; swapId: string | null; params: Prisma.JsonValue; raster?: Uint8Array | null },
    target: PrintTarget,
    stationCode: string | null,
    printer: { model: string; paperSize: string } | null,
  ): Promise<{ raster: Buffer; widthBytes: number }> {
    if (job.kind.startsWith('drawn_')) {
      const drawn = job.params as { model: string; paperSize: string; widthDots: number; heightDots: number };
      if (!job.raster) throw new BadRequestException('This label has nothing left to print');
      if (!printer || !drawnFor(target, printer, drawn)) {
        throw new BadRequestException('The printer was set up differently after this label was drawn');
      }
      return { raster: Buffer.from(job.raster), widthBytes: drawn.widthDots / 8 };
    }
    const rows = await this.render(job, target, stationCode);
    // A bare raster, not a finished job: the firmware wraps it in ESC/POS
    // itself and adds its own feed rows. The width is taken from the rows
    // rather than the target, so it cannot disagree with the bytes beside it.
    return { raster: this.renderer.toRaster(rows), widthBytes: Math.ceil((rows[0]?.length ?? 0) / 8) };
  }

  /**
   * Turns one job into one raster, through the same resolver the browser uses.
   * A receipt's item list paginates, and each page is its own job, so the job's
   * `page` param selects which of the resolved pages this one prints.
   */
  private async render(
    job: { orgId: string; kind: string; itemId: string | null; sellerId: string | null; swapId: string | null; params: Prisma.JsonValue },
    target: PrintTarget,
    /** The code of the station that queued the job — a helper sticker's letter. */
    stationCode: string | null,
  ): Promise<boolean[][]> {
    // Helper stickers carry their own text, as the iPad sent it (Plan 28), and
    // the letter of the station that asked: a legacy ticket number has none.
    if (job.kind === 'helper_item' || job.kind === 'helper_office') {
      const [item, office] = await this.renderer.helperLabels(job.params as unknown as HelperLabelData, stationCode, target);
      return job.kind === 'helper_item' ? item : office;
    }
    const pages = await this.recipes.resolve(
      job.orgId,
      {
        kind: job.kind as PrintRecipeKind,
        itemId: job.itemId,
        sellerId: job.sellerId,
        swapId: job.swapId,
      },
      target,
    );
    const page = Number((job.params as { page?: number } | null)?.page ?? 0);
    if (!pages[page]) throw new BadRequestException(`Label page ${page} no longer exists`);
    return pages[page];
  }

}

/**
 * Whether a raster was drawn for this printer as it is set up now: its model,
 * its stock, the full head width and the label's height, and its margins when
 * the iPad sent them.
 */
function drawnFor(
  target: PrintTarget,
  printer: { model: string; paperSize: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number },
  drawn: {
    model: string; paperSize: string; widthDots: number; heightDots: number;
    margins?: { top: number; bottom: number; left: number; right: number };
  },
): boolean {
  const geometry = geometryOf(target);
  if (drawn.model !== printer.model || drawn.paperSize !== printer.paperSize) return false;
  if (drawn.widthDots !== geometry.headWidthDots || drawn.heightDots !== geometry.canvasHeightDots) return false;
  if (drawn.margins) {
    const m = target.margins;
    if (drawn.margins.top !== m.marginTop || drawn.margins.bottom !== m.marginBottom
      || drawn.margins.left !== m.marginLeft || drawn.margins.right !== m.marginRight) return false;
  }
  return true;
}
