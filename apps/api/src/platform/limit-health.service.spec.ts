import { LimitHealthService } from './limit-health.service';
import type { UsageBucket } from '../common/limits/limit-usage.service';
import { LIMITS } from '../common/limits/limits';

const HOUR = 3_600_000;
const thisHour = Math.floor(Date.now() / HOUR) * HOUR;

function build(stored: UsageBucket[], unflushed: UsageBucket[] = []) {
  const prisma = {
    limitUsage: {
      findMany: async () => stored.map((b) => ({ ...b, hourStart: new Date(b.hourStart) })),
    },
    organization: { findMany: async () => [{ id: 'org-1', name: 'Stowe Ski Patrol' }] },
    skiSwap: { findMany: async () => [{ id: 'swap-1', title: 'Fall Swap' }] },
  };
  const usage = { unflushed: () => unflushed.map((b) => ({ ...b })) };
  return new LimitHealthService(prisma as never, usage as never);
}

const row = (over: Partial<UsageBucket>): UsageBucket => ({
  limitId: 'checkin.register', hourStart: thisHour, orgId: '', swapId: '',
  peakHits: 1, limitValue: 200, nearCount: 0, refusedCount: 0, ...over,
});

describe('LimitHealthService', () => {
  it('lists every limit in the registry, counted or not', async () => {
    const res = await build([]).summary('24h');
    expect(res.limits.map((l) => l.id)).toEqual(Object.keys(LIMITS));
    expect(res.limits.every((l) => l.peak === null && l.refusedCount === 0)).toBe(true);
  });

  it('reports the closest a key came, against the limit in force then, and where', async () => {
    const res = await build([
      row({ peakHits: 40, hourStart: thisHour - 3 * HOUR }),
      // A lower count against a lower limit is the closer call.
      row({ peakHits: 30, limitValue: 50, orgId: 'org-1', swapId: 'swap-1', hourStart: thisHour - 2 * HOUR }),
      row({ nearCount: 2, refusedCount: 3 }),
    ]).summary('24h');

    const register = res.limits.find((l) => l.id === 'checkin.register')!;
    expect(register.peak).toMatchObject({
      percent: 60, hits: 30, limit: 50,
      org: { name: 'Stowe Ski Patrol' }, swap: { title: 'Fall Swap' },
    });
    expect(register).toMatchObject({ nearCount: 2, refusedCount: 3 });
  });

  it('merges in the minute not yet written, so "now" is now', async () => {
    const res = await build(
      [row({ peakHits: 10, refusedCount: 1 })],
      [row({ peakHits: 150, refusedCount: 2 })],
    ).summary('24h');
    expect(res.limits.find((l) => l.id === 'checkin.register')!).toMatchObject({
      peak: { hits: 150, percent: 75 }, refusedCount: 3,
    });
  });

  it('draws a point for every hour of the day, empty where nothing was counted', async () => {
    const series = await build([
      row({ peakHits: 100 }),
      row({ peakHits: 20, hourStart: thisHour - 5 * HOUR, orgId: 'org-1' }),
    ]).series('checkin.register', '24h');

    expect(series.bucket).toBe('hour');
    expect(series.points).toHaveLength(24);
    expect(series.points.at(-1)).toMatchObject({ percent: 50 });
    expect(series.points.filter((p) => p.percent !== null)).toHaveLength(2);
    expect(series.top.map((p) => p.percent)).toEqual([50, 10]);
  });

  it('goes daily past a week', async () => {
    const series = await build([]).series('checkin.register', '30d');
    expect(series.bucket).toBe('day');
    expect(series.points).toHaveLength(30);
  });

  it('refuses a limit that does not exist, and a range it does not offer', async () => {
    const svc = build([]);
    await expect(svc.series('nope', '24h')).rejects.toMatchObject({ status: 404 });
    expect(() => svc.parseRange('1y')).toThrow();
  });
});
