/**
 * How the Items page sorts (Plan 39 D3): by SKU, name, price, seller or tag.
 *
 * Applied to a light projection of every matching row, then the page is cut
 * from it. SQL can't order SKUs as numbers ("9" before "100") or compare names
 * the way people read them without per-column tricks; a few thousand short rows
 * sort in milliseconds here, by one rule the table and the tests share.
 */

import { BadRequestException } from '@nestjs/common';

/**
 * The Items page's status filters (Plan 39 D2). The first four are answered by
 * our own row; Sold and For sale by the swap's sales, as the dashboard and
 * payouts count them (after Sales check and exchanges), never by a stock read
 * of every item.
 */
export const ITEM_LIST_STATUSES = ['not_received', 'not_in_square', 'needs_price', 'picked_up', 'sold', 'for_sale'] as const;
export type ItemListStatus = (typeof ITEM_LIST_STATUSES)[number];

/** A row as the sales-based filters read it. */
export interface SalesFilterRow {
  id: string;
  squareVariationId: string | null;
  originalQuantity: number;
  consignedAt: Date | null;
  pickedUpAt: Date | null;
}

/**
 * Sold: sales cover every unit. For sale: on the floor (accepted, in Square,
 * not picked up) with units its sales don't cover. `sold` is units sold by
 * variation, after refunds, Sales check and exchanges.
 */
export function idsBySales(rows: SalesFilterRow[], sold: ReadonlyMap<string, number>, status: 'sold' | 'for_sale'): string[] {
  return rows.filter((r) => {
    const units = r.squareVariationId ? sold.get(r.squareVariationId) ?? 0 : 0;
    if (status === 'sold') return !!r.squareVariationId && units >= r.originalQuantity;
    return !!r.squareVariationId && !!r.consignedAt && !r.pickedUpAt && units < r.originalQuantity;
  }).map((r) => r.id);
}

export const ITEM_SORTS = ['sku', 'name', 'price', 'seller', 'tag'] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];
export type SortDir = 'asc' | 'desc';

/** What sorting reads of a row. */
export interface SortRow {
  id: string;
  sku: string;
  name: string;
  priceCents: number | null;
  /** The name shown for the seller, or null for none. */
  sellerName: string | null;
  hasPrintedTag: boolean;
}

// One collator, made once: `localeCompare` with options builds one per call,
// which at 10,000 rows is most of a sort's time.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const text = collator.compare;

/**
 * Sorted by one column. A missing price or seller goes last whichever way,
 * since it's what's being looked for or what's in the way, not a value. Ties
 * keep SKU order, so a sort is the same from one load to the next.
 */
export function sortRows<T extends SortRow>(rows: T[], sort: ItemSort, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (r: SortRow): string | number | null => {
    switch (sort) {
      case 'sku': return r.sku;
      case 'name': return r.name;
      case 'price': return r.priceCents;
      case 'seller': return r.sellerName;
      case 'tag': return r.hasPrintedTag ? 1 : 0;
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va === null || vb === null) return va === vb ? text(a.sku, b.sku) : va === null ? 1 : -1;
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : text(String(va), String(vb));
    return c !== 0 ? sign * c : text(a.sku, b.sku);
  });
}

/**
 * A search with no sort asked for is sorted by the field it was searching:
 * by SKU when it matches SKUs, else by name when it matches names, else by
 * seller (it matched only sellers' names, emails or phones). "6701" sorts by
 * SKU; "rossignol" by name; "dana" by seller.
 */
export function searchedField(
  rows: { sku: string; name: string }[],
  query: string,
): Extract<ItemSort, 'sku' | 'name' | 'seller'> {
  const q = query.trim().toLowerCase();
  if (rows.some((r) => r.sku.toLowerCase().includes(q))) return 'sku';
  if (rows.some((r) => r.name.toLowerCase().includes(q))) return 'name';
  return 'seller';
}

/**
 * A search's best matches first, ahead of the field order: the ticket whose
 * SKU is the search, then SKUs that contain it, then names, then rows that
 * matched only their seller (a name, email or phone). "87024" lists 87024
 * first, not after every item of a seller whose phone has those digits in it.
 * Within a rank the order is kept, so the rest still read by SKU or name.
 */
export function bySearchRank<T extends { sku: string; name: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const rank = (r: T): number => {
    const sku = r.sku.toLowerCase();
    if (sku === q) return 0;
    if (sku.includes(q)) return 1;
    if (r.name.toLowerCase().includes(q)) return 2;
    return 3;
  };
  const ranks = new Map(rows.map((r) => [r, rank(r)]));
  return [...rows].sort((a, b) => ranks.get(a)! - ranks.get(b)!);
}

/** Business sellers (a shop: `businessName` set), or individuals. */
export const SELLER_KINDS = ['business', 'individual'] as const;
export type SellerKind = (typeof SELLER_KINDS)[number];

/** The Items page's filters and sort, as the list takes them. */
export interface ItemListView {
  status?: ItemListStatus;
  /** Only items whose seller is a business, or an individual. */
  sellerKind?: SellerKind;
  printed?: boolean;
  sort?: ItemSort;
  dir?: SortDir;
}

/** Reads and checks the query string's `status`, `sellerKind`, `printed`, `sort` and `dir`. */
export function parseItemListView(q: { status?: string; sellerKind?: string; printed?: string; sort?: string; dir?: string }): ItemListView {
  const { status, sellerKind, printed, sort, dir } = q;
  if (sellerKind !== undefined && !(SELLER_KINDS as readonly string[]).includes(sellerKind)) {
    throw new BadRequestException(`sellerKind must be one of ${SELLER_KINDS.join(', ')}`);
  }
  if (status !== undefined && !(ITEM_LIST_STATUSES as readonly string[]).includes(status)) {
    throw new BadRequestException(`status must be one of ${ITEM_LIST_STATUSES.join(', ')}`);
  }
  if (sort !== undefined && !(ITEM_SORTS as readonly string[]).includes(sort)) {
    throw new BadRequestException(`sort must be one of ${ITEM_SORTS.join(', ')}`);
  }
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') throw new BadRequestException('dir must be asc or desc');
  if (printed !== undefined && printed !== 'true' && printed !== 'false') {
    throw new BadRequestException('printed must be true or false');
  }
  return {
    ...(status ? { status: status as ItemListStatus } : {}),
    ...(sellerKind ? { sellerKind: sellerKind as SellerKind } : {}),
    ...(printed ? { printed: printed === 'true' } : {}),
    ...(sort ? { sort: sort as ItemSort, dir: (dir ?? 'asc') as SortDir } : {}),
  };
}
