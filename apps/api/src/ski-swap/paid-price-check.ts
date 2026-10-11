import type { PosSaleLine } from './pos/pos.adapter';
import { lineKeyOf, netUnits, type CheckItem } from './sales-check';

/**
 * Sales check's paid-price check, kept pure so it can be tested.
 *
 * A seller is paid PatrolKit's listed price, never what the register took
 * (payouts §2). So a sale rung up at another price, typed at the register or
 * discounted, quietly leaves the difference with the patrol. Each such sale
 * is flagged until staff keep PatrolKit's price (a decision, keyed
 * `order:#price:line`) or set PatrolKit's price to what was paid, which
 * clears it by itself.
 */

/** A kept price's decision line: `#price:` and the sale line's uid. */
export const PRICE_LINE = '#price:';
export const priceLineOf = (lineUid: string) => `${PRICE_LINE}${lineUid}`;
export const priceKeyOf = (orderId: string, lineUid: string) => lineKeyOf(orderId, priceLineOf(lineUid));

export interface PaidPriceIssue {
  key: string;
  orderId: string;
  /** The sale line's own uid. */
  lineUid: string;
  paymentId: string | null;
  soldAt: Date;
  quantity: number;
  refundedQuantity: number;
  collectedCents: number;
  item: CheckItem & { priceCents: number };
  /** One unit as rung up, before discounts: what a clerk typed for a ticket with no price. */
  rungCents: number | null;
  /** One unit as paid, after discounts. */
  paidCents: number;
}

/**
 * `lines` as every reader counts them (`attributeSales`); `kept` the
 * `priceKeyOf` keys staff decided to keep PatrolKit's price on.
 */
export function paidPriceCheck(lines: PosSaleLine[], items: CheckItem[], kept: ReadonlySet<string>): PaidPriceIssue[] {
  const byVariation = new Map(items.filter((i) => i.squareVariationId && !i.deleted).map((i) => [i.squareVariationId!, i]));
  const out: PaidPriceIssue[] = [];
  for (const l of lines) {
    const item = byVariation.get(l.variationId);
    // No price of ours: the seller is paid what the clerk typed (Plan 32 D4).
    if (!item || item.priceCents === null || !l.lineUid) continue;
    if (l.quantity <= 0 || netUnits(l) <= 0) continue;
    const key = priceKeyOf(l.orderId, l.lineUid);
    if (kept.has(key)) continue;
    // Per unit rung up: a refund leaves the line's total as it was charged.
    const paidCents = Math.round(l.collectedCents / l.quantity);
    const rungOff = l.unitPriceCents !== null && l.unitPriceCents !== item.priceCents;
    if (!rungOff && paidCents === item.priceCents) continue;
    out.push({
      key, orderId: l.orderId, lineUid: l.lineUid, paymentId: l.paymentId ?? null, soldAt: l.soldAt,
      quantity: l.quantity, refundedQuantity: l.refundedQuantity, collectedCents: l.collectedCents,
      item: { ...item, priceCents: item.priceCents }, rungCents: l.unitPriceCents, paidCents,
    });
  }
  return out;
}
