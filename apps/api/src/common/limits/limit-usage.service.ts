import {
  BeforeApplicationShutdown, Injectable, Logger, OnModuleDestroy, OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AttributionResolver, type ResolvedAttribution } from './attribution-resolver.service';
import { currentAttribution, type RequestAttribution } from './request-attribution';
import { LIMITS, type LimitId } from './limits';

const HOUR = 60 * 60 * 1000;
const FLUSH_EVERY_MS = 60 * 1000;
export const RETENTION_MS = 90 * 24 * HOUR;
/** Rows per INSERT. Far above anything a minute produces; a bound all the same. */
const FLUSH_CHUNK = 500;

/** What kind of key a count was taken against — for the log, never the key. */
export type KeyKind = 'ip' | 'user' | 'device' | 'destination' | 'site';

export interface LimitHit {
  limitId: LimitId;
  /** How many this key has reached in the current window, this one included. */
  hits: number;
  /** Whether this one was refused. */
  refused: boolean;
  keyKind: KeyKind;
  /** For the half-limit warning: which route or path counted it. */
  where?: string;
  /**
   * Where the request came from, when the caller knows better than the current
   * request does — a sign-in that names its swap in its context, say.
   */
  attribution?: RequestAttribution & { orgSlug?: string };
}

/** One row of `LimitUsage`, before it is written. */
export interface UsageBucket {
  limitId: LimitId;
  hourStart: number;
  orgId: string;
  swapId: string;
  peakHits: number;
  limitValue: number;
  nearCount: number;
  refusedCount: number;
}

/**
 * How close traffic comes to each limit, kept by the hour (Plan 26 §10, §11).
 *
 * Every limit reports here on every count. The counts are folded in memory and
 * written once a minute — a write per request would be a database round trip
 * on every call just to keep a chart — with an upsert that can raise a stored
 * peak and never lower it. A restart flushes on the way down; a crash loses at
 * most the minute in hand, which for a record of peaks is acceptable.
 *
 * Counts only. The key a limit counted against — an address, an account, a
 * phone number — goes to neither the table nor the log.
 */
@Injectable()
export class LimitUsageService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(LimitUsageService.name);
  private pending = new Map<string, UsageBucket>();
  private timer?: NodeJS.Timeout;
  private lastPrune = 0;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: AttributionResolver,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_EVERY_MS);
    // Never the reason a process stays up.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  /**
   * Counts one hit against a limit.
   *
   * Returns at once: attribution may need a lookup, and a request must never
   * wait on bookkeeping about itself. Failures are logged and dropped.
   */
  record(hit: LimitHit): void {
    const limitValue = LIMITS[hit.limitId].limit;
    const near = hit.hits === Math.ceil(limitValue / 2);

    // §10. Once per key per window: the count passes through exactly half once
    // on its way up, whatever it does after.
    if (near) {
      this.logger.warn(
        { limit: hit.limitId, keyKind: hit.keyKind, where: hit.where, hits: hit.hits, limitValue },
        'A limit is half used',
      );
    }

    // The caller's own attribution wins, but only where it says something: an
    // `undefined` from a caller that knew nothing must not erase what the
    // request knew.
    const claimed: RequestAttribution & { orgSlug?: string } = { ...currentAttribution() };
    for (const [k, v] of Object.entries(hit.attribution ?? {})) {
      if (v) claimed[k as keyof typeof claimed] = v;
    }
    this.resolver
      .resolve(claimed)
      .then((where) => this.accumulate(hit, where, near, Date.now()))
      .catch((err) => this.logger.error({ err, limit: hit.limitId }, 'Could not record limit usage'));
  }

  /** Folds one hit into the bucket for its hour and place. Exposed for tests. */
  accumulate(hit: LimitHit, where: ResolvedAttribution, near: boolean, now: number): void {
    const limitValue = LIMITS[hit.limitId].limit;
    const hourStart = Math.floor(now / HOUR) * HOUR;
    const key = bucketKey(hit.limitId, hourStart, where.orgId, where.swapId);
    // Capped at the limit. Past it the answer is "refused", which has its own
    // column; a peak of 140% would only stretch the chart.
    const peakHits = Math.min(hit.hits, limitValue);

    const bucket = this.pending.get(key);
    if (bucket) {
      bucket.peakHits = Math.max(bucket.peakHits, peakHits);
      bucket.limitValue = limitValue;
      bucket.nearCount += near ? 1 : 0;
      bucket.refusedCount += hit.refused ? 1 : 0;
    } else {
      this.pending.set(key, {
        limitId: hit.limitId,
        hourStart,
        orgId: where.orgId,
        swapId: where.swapId,
        peakHits,
        limitValue,
        nearCount: near ? 1 : 0,
        refusedCount: hit.refused ? 1 : 0,
      });
    }
  }

  /** What is in memory and not yet written. The health page merges it in. */
  unflushed(): UsageBucket[] {
    return [...this.pending.values()].map((b) => ({ ...b }));
  }

  /**
   * Writes what has accumulated, and drops rows past retention.
   *
   * Serialized, so a shutdown flush waits for a timer flush in progress rather
   * than racing it. On failure the buckets go back, to be tried with the next.
   */
  flush(): Promise<void> {
    this.flushing = this.flushing.then(() => this.flushNow());
    return this.flushing;
  }

  private async flushNow(): Promise<void> {
    const buckets = [...this.pending.values()];
    this.pending = new Map();

    for (let i = 0; i < buckets.length; i += FLUSH_CHUNK) {
      const chunk = buckets.slice(i, i + FLUSH_CHUNK);
      try {
        await this.write(chunk);
      } catch (err) {
        this.logger.error({ err, rows: chunk.length }, 'Could not write limit usage; keeping it for the next flush');
        for (const b of buckets.slice(i)) this.restore(b);
        return;
      }
    }

    const now = Date.now();
    if (now - this.lastPrune >= HOUR) {
      try {
        await this.prisma.limitUsage.deleteMany({ where: { hourStart: { lt: new Date(now - RETENTION_MS) } } });
        this.lastPrune = now;
      } catch (err) {
        this.logger.error({ err }, 'Could not prune limit usage');
      }
    }
  }

  /**
   * One upsert per chunk. `GREATEST` is what makes a flush unable to lower a
   * peak: two flushes of the same hour keep the larger, and the counts add.
   */
  private async write(chunk: UsageBucket[]): Promise<void> {
    if (chunk.length === 0) return;
    const values = Prisma.join(
      chunk.map((b) => Prisma.sql`(
        ${b.limitId}, ${new Date(b.hourStart)}, ${b.orgId}, ${b.swapId},
        ${b.peakHits}, ${b.limitValue}, ${b.nearCount}, ${b.refusedCount}, NOW(3)
      )`),
    );
    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO \`LimitUsage\`
        (\`limitId\`, \`hourStart\`, \`orgId\`, \`swapId\`,
         \`peakHits\`, \`limitValue\`, \`nearCount\`, \`refusedCount\`, \`updatedAt\`)
      VALUES ${values}
      ON DUPLICATE KEY UPDATE
        \`peakHits\` = GREATEST(\`peakHits\`, VALUES(\`peakHits\`)),
        \`limitValue\` = VALUES(\`limitValue\`),
        \`nearCount\` = \`nearCount\` + VALUES(\`nearCount\`),
        \`refusedCount\` = \`refusedCount\` + VALUES(\`refusedCount\`),
        \`updatedAt\` = VALUES(\`updatedAt\`)
    `);
  }

  /** Puts an unwritten bucket back, merging with anything counted since. */
  private restore(b: UsageBucket): void {
    const key = bucketKey(b.limitId, b.hourStart, b.orgId, b.swapId);
    const current = this.pending.get(key);
    if (!current) {
      this.pending.set(key, b);
      return;
    }
    current.peakHits = Math.max(current.peakHits, b.peakHits);
    current.nearCount += b.nearCount;
    current.refusedCount += b.refusedCount;
  }
}

function bucketKey(limitId: string, hourStart: number, orgId: string, swapId: string): string {
  return `${limitId}\u0000${hourStart}\u0000${orgId}\u0000${swapId}`;
}
