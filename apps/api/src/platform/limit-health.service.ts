import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LimitUsageService, type UsageBucket } from '../common/limits/limit-usage.service';
import { LIMITS, isLimitId, type LimitId, type LimitKeyedBy } from '../common/limits/limits';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const HEALTH_RANGES = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY, '90d': 90 * DAY } as const;
export type HealthRange = keyof typeof HEALTH_RANGES;

export interface HealthPlace {
  org: { id: string; name: string } | null;
  swap: { id: string; title: string } | null;
}

export interface LimitSummary {
  id: LimitId;
  label: string;
  keyedBy: LimitKeyedBy;
  limit: number;
  windowSeconds: number;
  /** The closest any key came in the range, or null when nothing was counted. */
  peak: (HealthPlace & { percent: number; hits: number; limit: number; hourStart: string }) | null;
  nearCount: number;
  refusedCount: number;
}

export interface LimitsHealth {
  range: HealthRange;
  generatedAt: string;
  limits: LimitSummary[];
}

export interface LimitSeries {
  id: LimitId;
  range: HealthRange;
  bucket: 'hour' | 'day';
  /** One per bucket across the whole range; `percent` null where nothing was counted. */
  points: { at: string; percent: number | null; refusedCount: number }[];
  /** The orgs and swaps that came closest, most first. */
  top: (HealthPlace & { percent: number; refusedCount: number; nearCount: number })[];
}

/** How many places a series names. */
const TOP_PLACES = 5;

/**
 * The Server health page's data (Plan 26 §11): every limit in the registry, and
 * how close traffic has come to each.
 *
 * Reads what has been written and merges in what has not, so "right now" on the
 * page is right now rather than up to a minute ago.
 */
@Injectable()
export class LimitHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: LimitUsageService,
  ) {}

  parseRange(value: string | undefined): HealthRange {
    const range = value ?? '24h';
    if (!Object.prototype.hasOwnProperty.call(HEALTH_RANGES, range)) {
      throw new BadRequestException(`range must be one of ${Object.keys(HEALTH_RANGES).join(', ')}`);
    }
    return range as HealthRange;
  }

  async summary(range: HealthRange): Promise<LimitsHealth> {
    const buckets = await this.buckets(range);

    const byLimit = new Map<LimitId, UsageBucket[]>();
    for (const b of buckets) {
      if (!isLimitId(b.limitId)) continue; // a limit since removed from the registry
      byLimit.set(b.limitId, [...(byLimit.get(b.limitId) ?? []), b]);
    }

    const peaks = new Map<LimitId, UsageBucket>();
    for (const [id, rows] of byLimit) {
      peaks.set(id, rows.reduce((best, b) =>
        percentOf(b) > percentOf(best) || (percentOf(b) === percentOf(best) && b.hourStart > best.hourStart) ? b : best));
    }
    const names = await this.names([...peaks.values()]);

    const limits = (Object.keys(LIMITS) as LimitId[]).map((id): LimitSummary => {
      const def = LIMITS[id];
      const rows = byLimit.get(id) ?? [];
      const peak = peaks.get(id);
      return {
        id,
        label: def.label,
        keyedBy: def.keyedBy,
        limit: def.limit,
        windowSeconds: def.windowMs / 1000,
        peak: peak
          ? {
              percent: percentOf(peak),
              hits: peak.peakHits,
              limit: peak.limitValue,
              hourStart: new Date(peak.hourStart).toISOString(),
              ...names.place(peak),
            }
          : null,
        nearCount: rows.reduce((n, b) => n + b.nearCount, 0),
        refusedCount: rows.reduce((n, b) => n + b.refusedCount, 0),
      };
    });

    return { range, generatedAt: new Date().toISOString(), limits };
  }

  async series(limitId: string, range: HealthRange): Promise<LimitSeries> {
    if (!isLimitId(limitId)) throw new NotFoundException('No such limit');
    const rows = (await this.buckets(range)).filter((b) => b.limitId === limitId);

    // Hourly while that is a readable number of points; daily past a week.
    const bucket = HEALTH_RANGES[range] <= 7 * DAY ? 'hour' : 'day';
    const size = bucket === 'hour' ? HOUR : DAY;
    const end = Math.floor(Date.now() / size) * size;
    const start = end - HEALTH_RANGES[range] + size;

    const points = new Map<number, { percent: number | null; refusedCount: number }>();
    for (let at = start; at <= end; at += size) points.set(at, { percent: null, refusedCount: 0 });
    for (const b of rows) {
      const point = points.get(Math.floor(b.hourStart / size) * size);
      if (!point) continue;
      point.percent = Math.max(point.percent ?? 0, percentOf(b));
      point.refusedCount += b.refusedCount;
    }

    const places = new Map<string, { sample: UsageBucket; percent: number; refusedCount: number; nearCount: number }>();
    for (const b of rows) {
      const key = `${b.orgId}\u0000${b.swapId}`;
      const place = places.get(key) ?? { sample: b, percent: 0, refusedCount: 0, nearCount: 0 };
      place.percent = Math.max(place.percent, percentOf(b));
      place.refusedCount += b.refusedCount;
      place.nearCount += b.nearCount;
      places.set(key, place);
    }
    const ranked = [...places.values()]
      .sort((a, b) => b.percent - a.percent || b.refusedCount - a.refusedCount)
      .slice(0, TOP_PLACES);
    const names = await this.names(ranked.map((p) => p.sample));

    return {
      id: limitId,
      range,
      bucket,
      points: [...points].map(([at, p]) => ({ at: new Date(at).toISOString(), ...p })),
      top: ranked.map((p) => ({
        ...names.place(p.sample),
        percent: p.percent,
        refusedCount: p.refusedCount,
        nearCount: p.nearCount,
      })),
    };
  }

  /** Everything in the range: written rows, and the minute not yet written. */
  private async buckets(range: HealthRange): Promise<UsageBucket[]> {
    const since = Math.floor((Date.now() - HEALTH_RANGES[range]) / HOUR) * HOUR + HOUR;
    const stored = await this.prisma.limitUsage.findMany({
      where: { hourStart: { gte: new Date(since) } },
      select: {
        limitId: true, hourStart: true, orgId: true, swapId: true,
        peakHits: true, limitValue: true, nearCount: true, refusedCount: true,
      },
    });

    const merged = new Map<string, UsageBucket>();
    const keyOf = (b: UsageBucket) => `${b.limitId}\u0000${b.hourStart}\u0000${b.orgId}\u0000${b.swapId}`;
    for (const row of stored) {
      const b = { ...row, limitId: row.limitId as LimitId, hourStart: row.hourStart.getTime() };
      merged.set(keyOf(b), b);
    }
    for (const b of this.usage.unflushed()) {
      if (b.hourStart < since) continue;
      const existing = merged.get(keyOf(b));
      if (!existing) {
        merged.set(keyOf(b), b);
        continue;
      }
      existing.peakHits = Math.max(existing.peakHits, b.peakHits);
      existing.limitValue = b.limitValue;
      existing.nearCount += b.nearCount;
      existing.refusedCount += b.refusedCount;
    }
    return [...merged.values()];
  }

  /** Org and swap names for the rows a response mentions. */
  private async names(rows: UsageBucket[]) {
    const orgIds = [...new Set(rows.map((r) => r.orgId).filter(Boolean))];
    const swapIds = [...new Set(rows.map((r) => r.swapId).filter(Boolean))];
    const [orgs, swaps] = await Promise.all([
      orgIds.length
        ? this.prisma.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } })
        : [],
      swapIds.length
        ? this.prisma.skiSwap.findMany({ where: { id: { in: swapIds } }, select: { id: true, title: true } })
        : [],
    ]);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const swapById = new Map(swaps.map((s) => [s.id, s]));
    return {
      place: (b: UsageBucket): HealthPlace => ({
        org: b.orgId ? (orgById.get(b.orgId) ?? { id: b.orgId, name: 'Deleted organization' }) : null,
        swap: b.swapId ? (swapById.get(b.swapId) ?? { id: b.swapId, title: 'Deleted swap' }) : null,
      }),
    };
  }
}

/** How close a bucket's peak came, against the limit in force at the time. */
function percentOf(b: UsageBucket): number {
  if (b.limitValue <= 0) return 0;
  return Math.round((Math.min(b.peakHits, b.limitValue) / b.limitValue) * 1000) / 10;
}
