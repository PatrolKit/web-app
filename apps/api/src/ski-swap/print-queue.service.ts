import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import type { PrintJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LabelRendererService } from './printing/label-renderer.service';
import { PrintRecipeService, printTargetFor, type PrintRecipeKind } from './printing/print-recipe.service';
import type { PrintTarget } from './printing/geometry';
import type { StationQueueResponse } from '../contracts/ski-swap.contracts';

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

export type PrintJobKind = 'item' | 'receipt_header' | 'receipt_items' | 'qr' | 'calibration';

export interface ClaimedJob {
  id: string;
  kind: PrintJobKind;
  seq: number;
  /** The rendered raster, base64-encoded. */
  payload: string;
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

  /** Tells anything holding a claim for this station to look again now. */
  private wake(stationId: string): void {
    const listeners = this.waiting.get(stationId);
    if (!listeners) return;
    for (const notify of [...listeners]) notify();
  }

  /** Resolves when work is signalled for this station, or after `ms`. */
  private waitForWork(stationId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        listeners.delete(finish);
        if (listeners.size === 0) this.waiting.delete(stationId);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      const listeners = this.waiting.get(stationId) ?? new Set<() => void>();
      this.waiting.set(stationId, listeners);
      listeners.add(finish);
    });
  }

  private readonly logger = new Logger(PrintQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly renderer: LabelRendererService,
    private readonly recipes: PrintRecipeService,
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
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId } });
    if (!item) throw new NotFoundException('Item not found');

    const station = await this.station(orgId, stationId);
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
  ): Promise<{
    stationId: string;
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
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: new Date(),
        // Only when reported. A bridge that says nothing leaves the previous
        // answer standing, and its age is what makes it readable.
        ...(printerLink ? { printerLink, printerLinkAt: new Date() } : {}),
        ...(scanner?.link ? { scannerLink: scanner.link, scannerLinkAt: new Date() } : {}),
        ...(scanner?.battery !== undefined ? { scannerBattery: scanner.battery } : {}),
        ...(scanner?.queueDepth !== undefined ? { scanQueueDepth: scanner.queueDepth } : {}),
      },
    });

    const station = await this.prisma.checkinStation.findFirst({
      where: { bridgeDeviceId: deviceId, deletedAt: null },
      include: { bridge: { include: { bridgedPrinter: true, bridgedScanner: true } } },
    });
    if (!station) throw new NotFoundException('This device is not bound to a station');

    /**
     * What this bridge should be holding, on every claim.
     *
     * The server has always known this and never said it, so changing which
     * printer a bridge drives meant walking to the board and re-provisioning it
     * over BLE. Null is a real answer — "drop what you are holding" — which is
     * why these are always present rather than omitted when empty.
     */
    const peripherals = {
      printer: station.bridge?.bridgedPrinter
        ? { bluetoothName: station.bridge.bridgedPrinter.bluetoothName }
        : null,
      scanner: station.bridge?.bridgedScanner
        ? { bluetoothName: station.bridge.bridgedScanner.bluetoothName }
        : null,
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
             claimToken = NULL,
             claimUntil = NULL,
             lastError = COALESCE(lastError, 'Claimed but never acknowledged')
       WHERE stationId = ${station.id}
         AND status = 'claimed'
         AND claimUntil < NOW(3)
         AND attempts >= ${MAX_ATTEMPTS}`;
    if (abandoned > 0) {
      this.logger.warn(
        { stationId: station.id, abandoned },
        'Abandoned print jobs that were claimed but never acknowledged',
      );
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
         WHERE stationId = ${station.id}
           AND attempts < ${MAX_ATTEMPTS}
           AND (status = 'queued' OR (status = 'claimed' AND claimUntil < NOW(3)))
         ORDER BY seq, createdAt
         LIMIT ${limit}`;
      return this.prisma.printJob.findMany({
        where: { claimToken: token },
        orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
      });
    };

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
            where: { stationId: station.id, status: 'claimed' },
          });

    if (claimed.length === 0 && outstanding === 0 && limit > 0 && res && hold > 0) {
      let clientGone = false;
      const onClose = () => { clientGone = true; this.wake(station.id); };
      res.on('close', onClose);
      try {
        const deadline = Date.now() + hold;
        while (claimed.length === 0 && !clientGone && Date.now() < deadline) {
          await this.waitForWork(station.id, Math.min(RECHECK_MS, deadline - Date.now()));
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
    const target = printTargetFor(station.bridge?.bridgedPrinter ?? null);
    const jobs: ClaimedJob[] = [];
    for (const job of claimed) {
      try {
        const rows = await this.render(job, target);
        jobs.push({
          id: job.id,
          kind: job.kind as PrintJobKind,
          seq: job.seq,
          // A bare raster, not a finished job: the firmware wraps it in ESC/POS
          // itself and adds its own feed rows.
          payload: this.renderer.toRaster(rows).toString('base64'),
          // Taken from the raster rather than the target, so it cannot disagree
          // with the bytes beside it.
          widthBytes: Math.ceil((rows[0]?.length ?? 0) / 8),
        });
      } catch (err) {
        // Nobody is watching a claim the way a seller watches a save, so a
        // recipe that no longer resolves fails once, visibly, instead of
        // retrying until it is abandoned.
        const message = err instanceof Error ? err.message : 'Render failed';
        this.logger.error({ err, jobId: job.id }, 'Print job render failed');
        await this.prisma.printJob.update({
          where: { id: job.id },
          data: { status: 'failed', lastError: message.slice(0, 500) },
        });
      }
    }

    return {
      stationId: station.id,
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
    if (job.status === 'printed') return; // idempotent: a retried ack is safe

    await this.prisma.printJob.update({
      where: { id: job.id },
      data: { status: 'printed', printedAt: new Date(), claimToken: null },
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
    const [queued, claimed, failed, abandoned, oldest, bridge, attendant] = await Promise.all([
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'queued' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'claimed' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'failed' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'abandoned' } }),
      this.prisma.printJob.findFirst({
        where: { stationId: station.id, status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      station.bridgeDeviceId
        ? this.prisma.device.findUnique({
            where: { id: station.bridgeDeviceId },
            select: { lastSeenAt: true, printerLink: true, printerLinkAt: true },
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
      oldestQueuedAt: oldest?.createdAt.toISOString() ?? null,
      bridgeLastSeenAt: bridge?.lastSeenAt?.toISOString() ?? null,
      attendantLastSeenAt: attendant?.lastSeenAt?.toISOString() ?? null,
      printerLink: (bridge?.printerLink as 'ready' | 'down' | null) ?? null,
      printerLinkAt: bridge?.printerLinkAt?.toISOString() ?? null,
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

  private async ownedJob(deviceId: string, jobId: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, station: { bridgeDeviceId: deviceId } },
    });
    // Scoped through the binding, so a bridge can only ever touch its own work.
    if (!job) throw new NotFoundException('Job not found for this device');
    return job;
  }

  /**
   * Turns one job into one raster, through the same resolver the browser uses.
   * A receipt's item list paginates, and each page is its own job, so the job's
   * `page` param selects which of the resolved pages this one prints.
   */
  private async render(
    job: { orgId: string; kind: string; itemId: string | null; sellerId: string | null; swapId: string | null; params: Prisma.JsonValue },
    target: PrintTarget,
  ): Promise<boolean[][]> {
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
