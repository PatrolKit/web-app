import { Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { LimitUsageService, type LimitHit } from './limit-usage.service';
import type { AttributionResolver } from './attribution-resolver.service';
import type { PrismaService } from '../../prisma/prisma.service';
import { LIMITS } from './limits';

const HOUR = 3_600_000;
const platform = { orgId: '', swapId: '' };

function build(opts: { failWrites?: boolean } = {}) {
  const written: Prisma.Sql[] = [];
  const prisma = {
    $executeRaw: jest.fn((sql: Prisma.Sql) => {
      if (opts.failWrites) return Promise.reject(new Error('database is away'));
      written.push(sql);
      return Promise.resolve(1);
    }),
    limitUsage: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
  } as unknown as PrismaService;
  const resolver = { resolve: async () => platform } as unknown as AttributionResolver;
  return { svc: new LimitUsageService(prisma, resolver), written, prisma };
}

const hit = (over: Partial<LimitHit> = {}): LimitHit => ({
  limitId: 'auth.login', hits: 1, refused: false, keyKind: 'ip', ...over,
});

describe('LimitUsageService — the accumulator', () => {
  it('keeps the highest count and adds the others, per hour and place', () => {
    const { svc } = build();
    const t = 10 * HOUR;
    svc.accumulate(hit({ hits: 12 }), platform, false, t);
    svc.accumulate(hit({ hits: 40 }), platform, true, t + 1000);
    svc.accumulate(hit({ hits: 7, refused: true }), platform, false, t + 2000);
    // Another org, and the next hour, are rows of their own.
    svc.accumulate(hit({ hits: 3 }), { orgId: 'org-1', swapId: '' }, false, t);
    svc.accumulate(hit({ hits: 5 }), platform, false, t + HOUR);

    const rows = svc.unflushed();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.hourStart === t && r.orgId === '')).toMatchObject({
      peakHits: 40, nearCount: 1, refusedCount: 1, limitValue: LIMITS['auth.login'].limit,
    });
  });

  it('caps a peak at the limit — past it is what the refusals column is for', () => {
    const { svc } = build();
    svc.accumulate(hit({ hits: 999, refused: true }), platform, false, 0);
    expect(svc.unflushed()[0].peakHits).toBe(LIMITS['auth.login'].limit);
  });

  it('writes with GREATEST, so a flush can never lower a stored peak', async () => {
    const { svc, written } = build();
    svc.accumulate(hit({ hits: 2 }), platform, false, 0);
    await svc.flush();
    expect(written).toHaveLength(1);
    expect(written[0].sql).toMatch(/`peakHits`\s*=\s*GREATEST\(`peakHits`,\s*VALUES\(`peakHits`\)\)/);
    expect(written[0].sql).toMatch(/`refusedCount`\s*=\s*`refusedCount`\s*\+\s*VALUES/);
    expect(svc.unflushed()).toHaveLength(0);
  });

  it('keeps what it could not write, for the next flush', async () => {
    const { svc } = build({ failWrites: true });
    svc.accumulate(hit({ hits: 9, refused: true }), platform, false, 0);
    await svc.flush();
    svc.accumulate(hit({ hits: 4, refused: true }), platform, false, 0);
    expect(svc.unflushed()).toEqual([expect.objectContaining({ peakHits: 9, refusedCount: 2 })]);
  });
});

describe('LimitUsageService — the half-limit warning (§10)', () => {
  it('fires once per key per window, however far the count goes past half', async () => {
    const { svc } = build();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { limit } = LIMITS['auth.login'];

    // Two windows of the same key, each climbing to the limit and past it.
    for (let window = 0; window < 2; window++) {
      for (let n = 1; n <= limit + 5; n++) svc.record(hit({ hits: n, refused: n > limit }));
    }
    await new Promise((r) => setImmediate(r));

    const warnings = warn.mock.calls.filter(([, msg]) => msg === 'A limit is half used');
    expect(warnings).toHaveLength(2);
    // The kind of key, never the key.
    expect(warnings[0][0]).toEqual(expect.objectContaining({ limit: 'auth.login', keyKind: 'ip', hits: limit / 2 }));
    warn.mockRestore();
  });
});
