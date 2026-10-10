import type { PosOrderFees } from './pos/pos.adapter';

/**
 * Sales check's fee check (Plan 48), kept pure so it can be tested.
 *
 * Square's credit card surcharge (its convenience fee) applied on only some
 * of the swap's iPads, so the swap added its own percentage service charge
 * (the "Shop Fee") at the same rate. Each card sale ended up with one of:
 *
 *  - neither fee: counted, not flagged (nobody is chasing these);
 *  - the surcharge, or the Shop Fee: right;
 *  - both: flagged, so the Shop Fee is refunded;
 *
 * and a Shop Fee on a sale paid all in cash is flagged too. A flag clears
 * when Square shows either fee refunded, or when staff mark it handled.
 */

export type FeeKind = 'double_fee' | 'cash_fee';

/** A fee decision's line: an order has one fee check, keyed `order:#fee`. */
export const FEE_LINE = '#fee';
export const feeKeyOf = (orderId: string) => `${orderId}:${FEE_LINE}`;

export interface FeeIssue {
  key: string;
  kind: FeeKind;
  orderId: string;
  paymentId: string | null;
  soldAt: Date;
  cardCents: number;
  cashCents: number;
  /** The Shop Fee's name as charged, e.g. "Shop Fee". */
  shopFeeName: string;
  shopFeeCents: number;
  /** Square's surcharge, when charged too. */
  surchargeCents: number | null;
  /** What to refund: the Shop Fee, less any already refunded. */
  refundCents: number;
}

export interface MissedFees {
  /** Card sales with no fee at all. */
  orders: number;
  cardCents: number;
  /** At the fees' rate, when one was charged anywhere; else null. */
  feeCents: number | null;
  /** That rate, e.g. "2.6". */
  percentage: string | null;
}

/**
 * The Shop Fee: a percentage service charge that isn't Square's surcharge.
 * Any other service charge (a fixed one) is left alone.
 */
function shopFeeOf(o: PosOrderFees) {
  return o.charges.find((c) => !c.surcharge && c.percentage !== null);
}

export function feeCheck(orders: PosOrderFees[], handled: ReadonlySet<string>): { issues: FeeIssue[]; missed: MissedFees } {
  const issues: FeeIssue[] = [];
  const missed: MissedFees = { orders: 0, cardCents: 0, feeCents: null, percentage: null };
  for (const o of orders) {
    const surcharge = o.charges.find((c) => c.surcharge);
    const shop = shopFeeOf(o);
    missed.percentage ??= (surcharge ?? shop)?.percentage ?? null;

    if (!surcharge && !shop) {
      if (o.hasLines && o.cardCents > 0) { missed.orders++; missed.cardCents += o.cardCents; }
      continue;
    }
    if (!shop || handled.has(feeKeyOf(o.orderId))) continue;
    const refundCents = shop.cents - shop.refundedCents;
    if (refundCents <= 0) continue;

    const both = !!surcharge && surcharge.refundedCents < surcharge.cents;
    const cashOnly = o.cardCents === 0 && o.cashCents > 0;
    if (!both && !cashOnly) continue;
    issues.push({
      key: feeKeyOf(o.orderId), kind: both ? 'double_fee' : 'cash_fee',
      orderId: o.orderId, paymentId: o.paymentId, soldAt: o.soldAt,
      cardCents: o.cardCents, cashCents: o.cashCents,
      shopFeeName: shop.name || 'Shop Fee', shopFeeCents: shop.cents,
      surchargeCents: surcharge ? surcharge.cents : null,
      refundCents,
    });
  }
  const rate = missed.percentage !== null ? Number(missed.percentage) : NaN;
  missed.feeCents = Number.isFinite(rate) ? Math.round(missed.cardCents * rate / 100) : null;
  return { issues, missed };
}
