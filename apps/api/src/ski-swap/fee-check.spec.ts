import { feeCheck } from './fee-check';
import type { PosOrderFees } from './pos/pos.adapter';

/** Sales check's fee check (Plan 48): the four ways a sale's fees went, and cash. */

type Charge = PosOrderFees['charges'][number];
const surcharge = (cents: number, refundedCents = 0): Charge => ({ uid: 'sur', name: 'Credit card surcharge', surcharge: true, percentage: '2.6', cents, refundedCents });
const shop = (cents: number, refundedCents = 0): Charge => ({ uid: 'shop', name: 'Shop Fee', surcharge: false, percentage: '2.6', cents, refundedCents });
const order = (id: string, charges: Charge[], paid: { card?: number; cash?: number } = { card: 10000 }): PosOrderFees => ({
  orderId: id, paymentId: `pay-${id}`, soldAt: new Date('2026-10-09T18:00:00Z'), hasLines: true,
  cardCents: paid.card ?? 0, cashCents: paid.cash ?? 0, charges,
});

describe('the fee check', () => {
  it('flags only a card sale charged both fees, and says to refund the Shop Fee', () => {
    const { issues } = feeCheck([
      order('none', []),
      order('surcharge', [surcharge(260)]),
      order('shop', [shop(260)]),
      order('both', [shop(767), surcharge(787)]),
    ], new Set());
    expect(issues.map((i) => [i.orderId, i.kind, i.refundCents, i.shopFeeCents, i.surchargeCents, i.key])).toEqual([
      ['both', 'double_fee', 767, 767, 787, 'both:#fee'],
    ]);
  });

  it('flags a Shop Fee on a sale paid all in cash, not on one partly by card', () => {
    const { issues } = feeCheck([
      order('cash', [shop(567)], { cash: 22367 }),
      order('split', [shop(100)], { card: 2000, cash: 2000 }),
    ], new Set());
    expect(issues.map((i) => [i.orderId, i.kind, i.refundCents])).toEqual([['cash', 'cash_fee', 567]]);
  });

  it('clears when Square shows either fee refunded, and leaves what remains of a part refund', () => {
    const { issues } = feeCheck([
      order('shop-refunded', [shop(767, 767), surcharge(787)]),
      order('surcharge-refunded', [shop(767), surcharge(787, 787)]),
      order('cash-refunded', [shop(1300, 1300)], { cash: 50000 }),
      order('part', [shop(767, 500), surcharge(787)]),
    ], new Set());
    expect(issues.map((i) => [i.orderId, i.refundCents])).toEqual([['part', 267]]);
  });

  it('leaves out one marked handled', () => {
    expect(feeCheck([order('both', [shop(767), surcharge(787)])], new Set(['both:#fee'])).issues).toEqual([]);
  });

  it('counts card sales charged no fee, at the fees’ rate, and not cash ones or refunds', () => {
    const { missed } = feeCheck([
      order('a', [], { card: 10000 }),
      order('b', [], { card: 5000, cash: 1000 }),
      order('cash', [], { cash: 4000 }),
      { ...order('refund', [], { card: 3000 }), hasLines: false },
      order('fee', [surcharge(260)]),
    ], new Set());
    expect(missed).toEqual({ orders: 2, cardCents: 15000, feeCents: 390, percentage: '2.6' });
  });

  it('ignores a fixed service charge', () => {
    const fixed: Charge = { uid: 'f', name: 'Delivery', surcharge: false, percentage: null, cents: 500, refundedCents: 0 };
    expect(feeCheck([order('x', [fixed, surcharge(260)])], new Set()).issues).toEqual([]);
  });
});
