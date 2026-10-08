import type { PosSaleLine } from './pos/pos.adapter';
import type { CheckoutTotal, SellerTotal } from '../contracts/ski-swap.contracts';
import { netOf } from './sales-heatmap';

/**
 * What the dashboard's two histograms count: each seller's items and money,
 * and each Square checkout's. Bucketing is the browser's, so its toggles
 * don't refetch.
 */

export interface SellerItemRow {
  sellerId: string;
  business: boolean;
  priceCents: number | null;
  squareVariationId: string | null;
  /** Withdrawn: not counted as listed, though a sale of it before then still counts. */
  deleted: boolean;
}

/**
 * Per seller: priced, live items and their asking prices; and what the
 * register took for any of their items, less refunds (null without Square).
 * An unpriced ticket isn't an item yet. A seller with nothing to count is
 * left out.
 */
export function sellerTotals(rows: SellerItemRow[], lines: PosSaleLine[] | null): SellerTotal[] {
  const bySeller = new Map<string, SellerTotal>();
  const sellerOfVariation = new Map<string, string>();
  for (const r of rows) {
    const t = bySeller.get(r.sellerId) ?? { business: r.business, items: 0, listedCents: 0, soldCents: lines ? 0 : null };
    if (!r.deleted && r.priceCents !== null) {
      t.items += 1;
      t.listedCents += r.priceCents;
    }
    bySeller.set(r.sellerId, t);
    if (r.squareVariationId) sellerOfVariation.set(r.squareVariationId, r.sellerId);
  }
  for (const line of lines ?? []) {
    const seller = sellerOfVariation.get(line.variationId);
    if (!seller) continue;
    const t = bySeller.get(seller)!;
    t.soldCents = (t.soldCents ?? 0) + netOf(line).cents;
  }
  return [...bySeller.values()].filter((t) => t.items > 0 || (t.soldCents ?? 0) > 0);
}

/**
 * Per Square order: the units and money of this swap's items in it, after
 * refunds. Square can't say who the buyer was, so a checkout stands in for
 * one. An order whose lines all came back is left out.
 */
export function checkoutTotals(lines: PosSaleLine[], variationIds: Set<string>): CheckoutTotal[] {
  const byOrder = new Map<string, CheckoutTotal>();
  for (const line of lines) {
    if (!variationIds.has(line.variationId)) continue;
    const { units, cents } = netOf(line);
    const t = byOrder.get(line.orderId) ?? { units: 0, cents: 0 };
    t.units += units;
    t.cents += cents;
    byOrder.set(line.orderId, t);
  }
  return [...byOrder.values()].filter((t) => t.units > 0);
}
