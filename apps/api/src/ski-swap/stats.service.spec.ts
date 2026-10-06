import { StatsService } from './stats.service';

/** The dashboard's figures come from our rows, with no Square read (Plan 39 D6). */
describe('swap stats', () => {
  function harness(opts: { sellers: string[]; firstCheckin: Date | null; createdBefore: string[] }) {
    let asked: Record<string, unknown> | undefined;
    const consigned = [
      { originalQuantity: 1, priceCents: 12000 },
      { originalQuantity: 2, priceCents: 1500 },
      { originalQuantity: 1, priceCents: null },
    ];
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap' }) },
      swapItem: {
        count: () => 'count',
        findMany: () => 'findMany',
        findFirst: async () => (opts.firstCheckin ? { createdAt: opts.firstCheckin } : null),
      },
      sellerProfile: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          asked = args.where;
          return opts.createdBefore.map((id) => ({ id }));
        },
      },
      $transaction: async () => [4, opts.sellers.map((sellerId) => ({ sellerId })), consigned, 2],
    };
    return { svc: new StatsService(prisma as never), asked: () => asked };
  }

  it('values what’s consigned at listed prices, counting what still needs one', async () => {
    const { svc } = harness({ sellers: ['s1', 's2'], firstCheckin: new Date('2026-10-05'), createdBefore: ['s1'] });
    expect(await svc.getSwapStats('org', 'swap')).toEqual({
      totalItems: 4, totalSellers: 2, returningSellers: 1, newSellers: 1, unpricedItems: 2,
      consignedItems: 3, consignedUnpriced: 1, consignedValueCents: 15000,
    });
  });

  it('counts a seller as returning when they were a seller before the first check-in', async () => {
    const first = new Date('2026-10-05T17:32:00Z');
    const { svc, asked } = harness({ sellers: ['s1', 's2', 's3'], firstCheckin: first, createdBefore: ['s1', 's3'] });
    expect(await svc.getSwapStats('org', 'swap')).toMatchObject({ totalSellers: 3, returningSellers: 2, newSellers: 1 });
    expect(asked()).toEqual({ id: { in: ['s1', 's2', 's3'] }, createdAt: { lt: first } });
  });

  it('has nobody returning before anyone has checked in', async () => {
    const { svc } = harness({ sellers: [], firstCheckin: null, createdBefore: [] });
    expect(await svc.getSwapStats('org', 'swap')).toMatchObject({ totalSellers: 0, returningSellers: 0, newSellers: 0 });
  });
});
