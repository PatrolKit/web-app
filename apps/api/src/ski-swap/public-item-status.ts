/**
 * One item's status, as the public is told it (Plan 33).
 *
 * The staff list and the seller page disagree about an item Square has never
 * heard of: one calls it sold (no stock), the other unsold (all its stock).
 * Neither is something to tell a member of the public, so this says it can't
 * tell rather than guessing.
 */
export type PublicItemStatus = 'not_received' | 'for_sale' | 'sold' | 'unknown';

export function publicItemStatus(
  item: { consignedAt: Date | null; squareVariationId: string | null; originalQuantity: number },
  /** Square's in-stock counts by variation, or null when Square couldn't be read. */
  counts: Map<string, number> | null,
): { status: PublicItemStatus; soldCount: number | null; quantity: number } {
  const quantity = item.originalQuantity;
  // Not yet taken in: nobody has handled it, so it can't be for sale.
  if (!item.consignedAt) return { status: 'not_received', soldCount: null, quantity };
  if (!item.squareVariationId || counts === null) return { status: 'unknown', soldCount: null, quantity };

  const inStock = counts.get(item.squareVariationId) ?? 0;
  const soldCount = Math.min(quantity, Math.max(0, quantity - inStock));
  return { status: soldCount >= quantity ? 'sold' : 'for_sale', soldCount, quantity };
}
