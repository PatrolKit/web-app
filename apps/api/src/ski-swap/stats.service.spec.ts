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
      skiSwap: { findFirst: async () => ({ id: 'swap' }) },
      swapItem: { count: () => 'count', findMany: () => 'findMany' },
      $transaction: async () => [4, [{ sellerId: 's1' }, { sellerId: 's2' }], consigned, 2],
    };
    const stats = await new StatsService(prisma as never).getSwapStats('org', 'swap');
    expect(stats).toEqual({
      totalItems: 4, totalSellers: 2, unpricedItems: 2,
      consignedItems: 3, consignedUnpriced: 1, consignedValueCents: 15000,
    });
  });
});
