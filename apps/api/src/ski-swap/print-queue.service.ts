import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LabelRendererService } from './printing/label-renderer.service';
import { PrintRecipeService, printTargetFor, type PrintRecipeKind } from './printing/print-recipe.service';
import type { PrintTarget } from './printing/geometry';
import type { StationQueueResponse } from '../contracts/ski-swap.contracts';

/** How long a claimed job is held before it returns to the queue. */
const CLAIM_SECONDS = 90;
/** Attempts before a job is abandoned rather than retried forever. */
const MAX_ATTEMPTS = 5;
/** Polling cadence hints, in ms — the seller is stood at the printer waiting. */
const BACKOFF_ACTIVE = 1000;
const BACKOFF_IDLE = 5000;

export type PrintJobKind = 'item' | 'receipt_header' | 'receipt_items' | 'qr' | 'calibration';

export interface ClaimedJob {
  id: string;
  kind: PrintJobKind;
  seq: number;
  /** The rendered raster, base64-encoded. */
  payload: string;
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
        printerId: station.printerId,
        swapId: params.swapId,
        sellerId: params.sellerId,
        itemId: params.itemId,
        kind: 'item',
        seq: i,
      })),
    });
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
        printerId: station.printerId,
        swapId: item.swapId,
        sellerId: item.sellerId,
        itemId: item.id,
        kind: 'item',
        seq: 0,
      },
    });
  }

  /** Queues a seller's receipt: a header, then a page per batch of line items. */
  async enqueueReceipt(params: {
    orgId: string;
    stationId: string;
    swapId: string;
    sellerId: string;
    pageCount: number;
  }): Promise<void> {
    const station = await this.station(params.orgId, params.stationId);
    const base = {
      orgId: params.orgId,
      stationId: station.id,
      printerId: station.printerId,
      swapId: params.swapId,
      sellerId: params.sellerId,
    };
    await this.prisma.printJob.createMany({
      data: [
        { ...base, id: createId(), kind: 'receipt_header', seq: 0 },
        ...Array.from({ length: params.pageCount }, (_, i) => ({
          ...base,
          id: createId(),
          kind: 'receipt_items',
          params: { page: i } as Prisma.InputJsonValue,
          seq: i + 1,
        })),
      ],
    });
  }

  /** Exercises the whole chain: server, bridge, BLE link, printer. */
  async enqueueCalibration(orgId: string, stationId: string): Promise<void> {
    const station = await this.station(orgId, stationId);
    await this.prisma.printJob.create({
      data: {
        id: createId(),
        orgId,
        stationId: station.id,
        printerId: station.printerId,
        kind: 'calibration',
        seq: 0,
      },
    });
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
  async claim(deviceId: string, limit = 4): Promise<{
    stationId: string;
    backoffMs: number;
    jobs: ClaimedJob[];
  }> {
    const station = await this.prisma.checkinStation.findFirst({
      where: { deviceId, deletedAt: null },
      include: { printer: true },
    });
    if (!station) throw new NotFoundException('This device is not bound to a station');

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

    const claimed = await this.prisma.printJob.findMany({
      where: { claimToken: token },
      orderBy: [{ seq: 'asc' }, { createdAt: 'asc' }],
    });

    // Rendering happens after the claim has committed, never inside it: holding
    // write locks across a canvas render would serialise stations against each
    // other for no reason.
    const target = printTargetFor(station.printer);
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

    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });

    return {
      stationId: station.id,
      backoffMs: jobs.length ? BACKOFF_ACTIVE : BACKOFF_IDLE,
      jobs,
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
    const [queued, claimed, failed, abandoned, oldest, device] = await Promise.all([
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'queued' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'claimed' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'failed' } }),
      this.prisma.printJob.count({ where: { stationId: station.id, status: 'abandoned' } }),
      this.prisma.printJob.findFirst({
        where: { stationId: station.id, status: 'queued' },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      station.deviceId
        ? this.prisma.device.findUnique({
            where: { id: station.deviceId },
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
      deviceLastSeenAt: device?.lastSeenAt?.toISOString() ?? null,
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
    });
    if (!station) throw new NotFoundException('Station not found');
    return station;
  }

  private async ownedJob(deviceId: string, jobId: string) {
    const job = await this.prisma.printJob.findFirst({
      where: { id: jobId, station: { deviceId } },
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
