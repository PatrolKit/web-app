import { StatsService } from './stats.service';

/** The dashboard's figures: consigned value comes from the rows, sales from Square. */
describe('swap stats', () => {
  function build(items: { squareVariationId: string | null; originalQuantity: number; priceCents: number | null; consignedAt: Date | null }[], inventory: Map<string, number> | null) {
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap', locationId: 'LOC' }) },
      swapItem: { count: () => 'count', findMany: () => 'findMany' },
      $transaction: async () => [items.length, [{ sellerId: 's1' }], items, items.filter((i) => i.priceCents === null).length],
    };
    const pos = { getInventoryCounts: async () => { if (!inventory) throw new Error('down'); return inventory; } };
    return new StatsService(prisma as never, { forOrg: async () => pos } as never);
  }

  const items = [
    { squareVariationId: 'v1', originalQuantity: 1, priceCents: 12000, consignedAt: new Date() },
    { squareVariationId: 'v2', originalQuantity: 2, priceCents: 1500, consignedAt: new Date() },
    { squareVariationId: null, originalQuantity: 1, priceCents: 9900, consignedAt: null },
    { squareVariationId: 'v4', originalQuantity: 1, priceCents: null, consignedAt: new Date() },
  ];

  it('values what’s consigned at listed prices, before anything sells', async () => {
    const stats = await build(items, new Map([['v1', 1], ['v2', 2], ['v4', 1]])).getSwapStats('org', 'swap');
    expect(stats).toMatchObject({ consignedItems: 3, consignedUnpriced: 1, consignedValueCents: 15000, itemsSold: 0, grossRevenueCents: 0 });
  });

  it('counts revenue only from what Square says sold', async () => {
    const stats = await build(items, new Map([['v1', 0], ['v2', 1], ['v4', 1]])).getSwapStats('org', 'swap');
    expect(stats).toMatchObject({ itemsSold: 2, grossRevenueCents: 13500, consignedValueCents: 15000 });
  });

  it('still values what’s consigned when Square can’t be read', async () => {
    const stats = await build(items, null).getSwapStats('org', 'swap');
    expect(stats).toMatchObject({ inventoryKnown: false, consignedValueCents: 15000 });
  });
});
