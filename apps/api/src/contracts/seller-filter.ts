/**
 * The Sellers page's filters and sort, as one rule: the page filters with it,
 * and the export finds the same sellers with it, so the two can't disagree.
 * Kept free of imports so the web can use it as is.
 */

export type SellerPayoutKey = 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE' | 'NONE';
export type SellerSortKey = 'displayName' | 'email' | 'phone' | 'payoutMethod';

/** What the page filters on. `incomplete` ("can't be paid") is the server's own filter. */
export interface SellerFilters {
  search?: string;
  type?: 'individual' | 'business';
  payout?: SellerPayoutKey;
  incomplete?: boolean;
  sort?: SellerSortKey;
  dir?: 'asc' | 'desc';
}

/** The fields the rule reads, a subset of a seller response. */
export interface FilterableSeller {
  displayName: string;
  businessName: string | null;
  phone: string | null;
  email: string | null;
  payoutMethod: 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE' | null;
}

export const SELLER_PAYOUT_KEYS: SellerPayoutKey[] = ['CHECK', 'PAYPAL', 'VENMO', 'DONATE', 'NONE'];
export const SELLER_SORT_KEYS: SellerSortKey[] = ['displayName', 'email', 'phone', 'payoutMethod'];

/** The payout column's key: the method, or NONE for one not chosen. */
export const payoutKeyOf = (s: Pick<FilterableSeller, 'payoutMethod'>): SellerPayoutKey => s.payoutMethod ?? 'NONE';

/** Whether a seller matches the search (name, phone or email), type and payout. */
export function sellerMatches(s: FilterableSeller, f: Pick<SellerFilters, 'search' | 'type' | 'payout'>): boolean {
  const q = (f.search ?? '').trim().toLowerCase();
  const matchesSearch = !q
    || s.displayName.toLowerCase().includes(q)
    || (s.phone ?? '').includes(q)
    || (s.email ?? '').toLowerCase().includes(q);
  const matchesType = !f.type || (s.businessName ? 'business' : 'individual') === f.type;
  const matchesPayout = !f.payout || payoutKeyOf(s) === f.payout;
  return matchesSearch && matchesType && matchesPayout;
}

/** The page's order: by one column, as text; a missing value sorts as empty. */
export function sortSellers<T extends FilterableSeller>(sellers: T[], sort: SellerSortKey = 'displayName', dir: 'asc' | 'desc' = 'asc'): T[] {
  return [...sellers].sort((a, b) => {
    const av = a[sort] ?? '';
    const bv = b[sort] ?? '';
    return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
  });
}
