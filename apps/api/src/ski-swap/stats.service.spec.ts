import { StatsService } from './stats.service';

/** The dashboard's figures come from our rows, with no Square read (Plan 39 D6). */
describe('swap stats', () => {
  it('values what’s consigned at listed prices, counting what still needs one', async () => {
    const consigned = [
      { originalQuantity: 1, priceCents: 12000 },
      { originalQuantity: 2, priceCents: 1500 },
      { originalQuantity: 1, priceCents: null },
    ];
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap', createdAt: new Date('2026-09-01') }) },
      swapItem: {
        count: () => 'count',
        // Inside the transaction a placeholder; the earlier-swap lookup is awaited on its own.
        findMany: (args: { where: { swap?: unknown } }) => (args.where.swap ? Promise.resolve([{ sellerId: 's1' }]) : 'findMany'),
      },
      $transaction: async () => [4, [{ sellerId: 's1' }, { sellerId: 's2' }], consigned, 2],
    };
    const stats = await new StatsService(prisma as never).getSwapStats('org', 'swap');
    expect(stats).toEqual({
      totalItems: 4, totalSellers: 2, returningSellers: 1, newSellers: 1, unpricedItems: 2,
      consignedItems: 3, consignedUnpriced: 1, consignedValueCents: 15000,
    });
  });

  it('counts a seller as returning when they had an item in a swap that started earlier', async () => {
    let asked: Record<string, unknown> | undefined;
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap', createdAt: new Date('2026-09-01') }) },
      swapItem: {
        count: () => 'count',
        findMany: (args: { where: Record<string, unknown> }) => {
          if (!args.where.swap) return 'findMany';
          asked = args.where;
          return Promise.resolve([]);
        },
      },
      $transaction: async () => [1, [{ sellerId: 's1' }], [], 0],
    };
    const stats = await new StatsService(prisma as never).getSwapStats('org', 'swap');
    expect(stats).toMatchObject({ totalSellers: 1, returningSellers: 0, newSellers: 1 });
    expect(asked).toMatchObject({ orgId: 'org', sellerId: { in: ['s1'] }, swap: { createdAt: { lt: new Date('2026-09-01') } } });
  });
});
