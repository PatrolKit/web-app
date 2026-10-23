import { moneySummary } from './money-summary';
import type { BuiltLine } from './build-run';
import type { PosOrderFees, PosSaleLine } from '../pos/pos.adapter';

const at = new Date('2026-10-09T18:00:00Z');
const sale = (orderId: string, variationId: string, collectedCents: number, over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId, variationId, lineUid: `${orderId}-u`, quantity: 1, collectedCents, unitPriceCents: collectedCents, refundedQuantity: 0, soldAt: at, ...over,
});
const fees = (orderId: string, over: Partial<PosOrderFees> = {}): PosOrderFees => ({
  orderId, paymentId: null, soldAt: at, hasLines: true, cardCents: 0, cashCents: 0, charges: [], ...over,
});
const item = (priceCents: number, squareOrderId = 'o1') => ({
  itemId: 'i', name: 'Skis', sku: '1', priceCents, quantity: 1, collectedCents: priceCents, squareOrderId, soldAt: at, refundedQty: 0, paymentId: null, lineUid: null,
});
const line = (method: BuiltLine['method'], items: ReturnType<typeof item>[], bps = 2000): BuiltLine => {
  const gross = items.reduce((n, i) => n + i.priceCents, 0);
  const commission = Math.round((gross * bps) / 10_000);
  return { sellerId: 's', sellerName: 'S', method, destination: null, destinationType: null, grossCents: gross, commissionCents: commission, netCents: gross - commission, status: method === 'DONATE' ? 'DONATED' : 'PENDING', statusNote: null, items };
};

describe('the Payouts page’s money card', () => {
  it('counts swap sales less returns, plus fees charged, less Square’s fees, for swap orders only', () => {
    const m = moneySummary({
      sales: [
        sale('o1', 'v1', 10_000),
        sale('o2', 'v2', 4_000, { quantity: 2, refundedQuantity: 1 }), // half returned
        sale('o3', 'swag', 2_500),                                    // not a swap item
        sale('comp:c1', 'v1', 0),                                     // a comp collects nothing
      ],
      ourVariations: new Set(['v1', 'v2']),
      fees: [
        fees('o1', { charges: [{ uid: 'f', name: 'Shop Fee', surcharge: false, percentage: '3', cents: 300, refundedCents: 0 }], processingFeeCents: 290,
          payments: [{ kind: 'in_person', amountCents: 10_300, feeCents: 290 }] }),
        fees('o2', { charges: [{ uid: 'f', name: 'Shop Fee', surcharge: false, percentage: '3', cents: 120, refundedCents: 60 }], processingFeeCents: 120, processingFeeRefundedCents: 10,
          payments: [{ kind: 'keyed', amountCents: 4_120, feeCents: 120 }] }),
        fees('o3', { charges: [{ uid: 'f', name: 'Shop Fee', surcharge: false, percentage: '3', cents: 75, refundedCents: 0 }], processingFeeCents: 70,
          payments: [{ kind: 'in_person', amountCents: 2_575, feeCents: 70 }] }),
      ],
      lines: [],
      takeBps: 2000,
    });
    expect(m.incoming).toEqual({
      salesCents: 14_000, returnsCents: 2_000, feesChargedCents: 360, squareFeesCents: 400, totalCents: 12_000 + 360 - 400,
      // By how the card was taken, for swap orders only (o3 sold swag), and the fee returned on o2's refund.
      squareFeesDetail: {
        kinds: [{ kind: 'in_person', payments: 1, amountCents: 10_300, feeCents: 290 }, { kind: 'keyed', payments: 1, amountCents: 4_120, feeCents: 120 }],
        returnedCents: 10,
      },
    });
  });

  it('pays sellers their items and comps less the take, and leaves donors out', () => {
    const m = moneySummary({
      sales: [sale('o1', 'v1', 10_000)],
      ourVariations: new Set(['v1']),
      fees: null,
      lines: [line('PAYPAL', [item(10_000), item(4_000, 'comp:c1')]), line('DONATE', [item(6_000)])],
      takeBps: 2000,
    });
    expect(m.outgoing).toEqual({ itemsCents: 10_000, compsCents: 4_000, takeBps: 2000, takeCents: 2_800, totalCents: 11_200, donatedCents: 6_000 });
    expect(m.profitCents).toBe(10_000 - 11_200);
    expect(m.profitShare).toBeCloseTo(-0.12);
  });

  it('has no share of nothing', () => {
    expect(moneySummary({ sales: [], ourVariations: new Set(), fees: null, lines: [], takeBps: 2000 }).profitShare).toBeNull();
  });

  it('has no detail when only the total is known', () => {
    const m = moneySummary({ sales: [sale('o1', 'v1', 1_000)], ourVariations: new Set(['v1']), fees: [fees('o1', { processingFeeCents: 5 })], lines: [], takeBps: 2000 });
    expect([m.incoming.squareFeesDetail, m.incoming.squareFeesCents]).toEqual([null, 5]);
  });
});
