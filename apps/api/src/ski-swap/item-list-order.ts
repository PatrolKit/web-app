/**
 * How the Items page sorts (Plan 39 D3): by SKU, name, price, seller or tag.
 *
 * Applied to a light projection of every matching row, then the page is cut
 * from it. SQL can't order SKUs as numbers ("9" before "100") or compare names
 * the way people read them without per-column tricks; a few thousand short rows
 * sort in milliseconds here, by one rule the table and the tests share.
 */

import { BadRequestException } from '@nestjs/common';

/** The Items page's status filters (Plan 39 D2): each answered by our own row. */
export const ITEM_LIST_STATUSES = ['not_received', 'not_in_square', 'needs_price'] as const;
export type ItemListStatus = (typeof ITEM_LIST_STATUSES)[number];

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

/** The Items page's filters and sort, as the list takes them. */
export interface ItemListView {
  status?: ItemListStatus;
  printed?: boolean;
  sort?: ItemSort;
  dir?: SortDir;
}

/** Reads and checks the query string's `status`, `printed`, `sort` and `dir`. */
export function parseItemListView(q: { status?: string; printed?: string; sort?: string; dir?: string }): ItemListView {
  const { status, printed, sort, dir } = q;
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
    ...(printed ? { printed: printed === 'true' } : {}),
    ...(sort ? { sort: sort as ItemSort, dir: (dir ?? 'asc') as SortDir } : {}),
  };
}
