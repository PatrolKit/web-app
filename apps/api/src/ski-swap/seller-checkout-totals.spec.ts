import { checkoutTotals, sellerTotals, type SellerItemRow } from './seller-checkout-totals';
import type { PosSaleLine } from './pos/pos.adapter';

const line = (orderId: string, variationId: string, over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId, variationId, quantity: 1, collectedCents: 5000, unitPriceCents: 5000, refundedQuantity: 0, soldAt: new Date('2026-10-10T15:00:00Z'), ...over,
});
const row = (sellerId: string, over: Partial<SellerItemRow> = {}): SellerItemRow => ({
  sellerId, business: false, priceCents: 5000, squareVariationId: null, deleted: false, ...over,
});

describe('sellerTotals', () => {
  it('counts priced, live items and their prices, and what sold, per seller', () => {
    const rows = [
      row('a', { squareVariationId: 'v1', priceCents: 4000 }),
      row('a', { squareVariationId: 'v2', priceCents: 6000 }),
      row('b', { business: true, squareVariationId: 'v3', priceCents: 10000 }),
    ];
    const out = sellerTotals(rows, [line('o1', 'v1', { collectedCents: 3500 }), line('o2', 'v3', { collectedCents: 9000 })]);
    expect(out).toEqual([
      { business: false, items: 2, listedCents: 10000, soldCents: 3500 },
      { business: true, items: 1, listedCents: 10000, soldCents: 9000 },
    ]);
  });

  it('leaves out unpriced tickets and withdrawn items, but keeps a sale made before a withdrawal', () => {
    const rows = [row('a', { priceCents: null }), row('a', { deleted: true, squareVariationId: 'v1' })];
    expect(sellerTotals(rows, [line('o1', 'v1')])).toEqual([{ business: false, items: 0, listedCents: 0, soldCents: 5000 }]);
    expect(sellerTotals([row('a', { priceCents: null })], [])).toEqual([]);
  });

  it('takes refunds off, and says sold is unknown without Square', () => {
    const rows = [row('a', { squareVariationId: 'v1' })];
    expect(sellerTotals(rows, [line('o1', 'v1', { refundedQuantity: 1 })])[0].soldCents).toBe(0);
    expect(sellerTotals(rows, null)[0].soldCents).toBeNull();
  });

  it('ignores sales of anything that isn’t a seller’s item', () => {
    expect(sellerTotals([row('a', { squareVariationId: 'v1' })], [line('o1', 'other')])[0].soldCents).toBe(0);
  });
});

describe('checkoutTotals', () => {
  it('sums this swap’s lines per order, after refunds', () => {
    const lines = [
      line('o1', 'v1', { collectedCents: 2000 }),
      line('o1', 'v2', { quantity: 2, collectedCents: 6000, refundedQuantity: 1 }),
      line('o1', 'concessions'),
      line('o2', 'v1', { refundedQuantity: 1 }),
    ];
    expect(checkoutTotals(lines, new Set(['v1', 'v2']))).toEqual([{ units: 2, cents: 5000 }]);
  });
});
