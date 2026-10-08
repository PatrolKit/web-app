import type { ItemBreakdown } from '../../lib/api.types';

/**
 * The dashboard's Items tile (Plan 46 D3), kept apart from the component so
 * it can be tested: one segment per kind, in a fixed order and color, of a
 * single stacked bar, like the Sellers tile's.
 */

export interface ItemSegment {
  key: 'sold' | 'returned' | 'forSale' | 'noPrice' | 'noDescription' | 'notOnSale';
  label: string;
  count: number;
  /** Tailwind background class, for the segment and its legend square. */
  dot: string;
  /** The segment's share of the bar, as a CSS width. */
  width: string;
}

const KINDS: Omit<ItemSegment, 'count' | 'width'>[] = [
  { key: 'sold', label: 'Sold', dot: 'bg-green-500' },
  { key: 'returned', label: 'Returned', dot: 'bg-violet-400' },
  { key: 'forSale', label: 'For sale', dot: 'bg-sky-500' },
  { key: 'noPrice', label: 'No price', dot: 'bg-amber-400' },
  { key: 'noDescription', label: 'No description', dot: 'bg-pink-400' },
  { key: 'notOnSale', label: 'Not on sale', dot: 'bg-gray-500' },
];

export function itemSegments(b: Pick<ItemBreakdown, 'sold' | 'forSale' | 'noPrice' | 'noDescription' | 'notOnSale' | 'total'> & { returned?: number }): ItemSegment[] {
  const total = b.total || 0;
  return KINDS.map((k) => {
    // Absent from a server older than Plan 43: none returned.
    const count = b[k.key] ?? 0;
    return { ...k, count, width: total ? `${(count / total) * 100}%` : '0%' };
  });
}

export function percent(count: number, total: number): string {
  if (!total) return '0%';
  const p = (count / total) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}
