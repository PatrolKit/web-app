import { breakdown, soldByVariation, ItemBreakdownService, type BreakdownItem } from './item-breakdown.service';
import type { PosSaleLine } from './pos/pos.adapter';

const item = (sku: string, over: Partial<BreakdownItem> = {}): BreakdownItem => ({
  sku, name: 'Red Skis', priceCents: 4500, categoryId: 'cat', consigned: true,
  squareItemId: `sq-${sku}`, squareVariationId: `sv-${sku}`, originalQuantity: 1, ...over,
});
const sale = (variationId: string, quantity = 1, refundedQuantity = 0): PosSaleLine => ({
  orderId: 'o', variationId, quantity, refundedQuantity, collectedCents: 0, unitPriceCents: null, soldAt: new Date(),
});

describe('the dashboard pie', () => {
  it('puts every item in exactly one slice, sold first', () => {
    const items = [
      item('1'),                                                       // for sale
      item('2'),                                                       // sold
      item('3', { priceCents: null }),                                 // needs a price
      item('67169', { categoryId: null, name: 'Item #67169' }),        // never described
      item('5', { consigned: false }),                                 // waiting for a scan
      item('6', { squareItemId: null, squareVariationId: null }),      // missing from Square
      item('7', { priceCents: null, squareVariationId: 'sv-7' }),      // unpriced ticket that sold anyway
    ];
    const sold = soldByVariation([sale('sv-2'), sale('sv-7')]);
    expect(breakdown(items, sold)).toEqual({ sold: 2, forSale: 1, needsInfo: 2, notOnSale: 2, total: 7 });
  });

  it('counts an item named by an import, with no category, as described', () => {
    expect(breakdown([item('8', { categoryId: null, name: 'Volkl Kendo 88' })], new Map())).toMatchObject({ forSale: 1 });
  });

  it('nets out refunds, and needs every unit sold', () => {
    const sold = soldByVariation([sale('sv-1'), sale('sv-1', 1, 1), sale('sv-2', 1)]);
    expect(breakdown([item('1'), item('2', { originalQuantity: 2 })], sold)).toMatchObject({ sold: 1, forSale: 1 });
  });

  it('reads Square’s sales once per two minutes, and says so when it can’t', async () => {
    let reads = 0;
    const pos = { listSales: async () => { reads++; return [sale('sv-1')]; } };
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap', createdAt: new Date('2026-09-01'), locationId: 'loc' }) },
      swapItem: { findMany: async () => [{ ...item('1'), consignedAt: new Date() }] },
    };
    const svc = new ItemBreakdownService(prisma as never, { forOrg: async () => pos } as never);
    expect(await svc.get('org', 'swap')).toMatchObject({ sold: 1, total: 1, error: null });
    await svc.get('org', 'swap');
    expect(reads).toBe(1);

    const down = new ItemBreakdownService(prisma as never, { forOrg: async () => null } as never);
    expect(await down.get('org', 'swap')).toMatchObject({ error: expect.stringContaining('Square isn’t connected') });
  });
});
