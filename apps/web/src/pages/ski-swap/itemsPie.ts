import type { ItemBreakdown } from '../../lib/api.types';

/**
 * The dashboard pie's geometry and wording (kept apart from the component so
 * it can be tested): one slice per kind, in a fixed order and color.
 */

export interface PieSlice {
  key: 'sold' | 'forSale' | 'noPrice' | 'noDescription' | 'notOnSale';
  label: string;
  count: number;
  /** Tailwind fill and background classes, for the slice and its legend dot. */
  fill: string;
  dot: string;
  /** The SVG path, empty for a zero slice. */
  path: string;
  /** Where its number goes, or null when the slice is too thin to hold it. */
  labelAt: { x: number; y: number } | null;
}

export const PIE = { size: 180, outer: 86, inner: 52 };

const KINDS: Omit<PieSlice, 'count' | 'path' | 'labelAt'>[] = [
  { key: 'sold', label: 'Sold', fill: 'fill-green-500', dot: 'bg-green-500' },
  { key: 'forSale', label: 'For sale', fill: 'fill-sky-500', dot: 'bg-sky-500' },
  { key: 'noPrice', label: 'No price', fill: 'fill-amber-400', dot: 'bg-amber-400' },
  { key: 'noDescription', label: 'Priced, no description', fill: 'fill-orange-300', dot: 'bg-orange-300' },
  { key: 'notOnSale', label: 'Not on sale yet', fill: 'fill-gray-500', dot: 'bg-gray-500' },
];

/** Thinner than this and a slice's number goes only in the legend. */
const MIN_LABEL_FRACTION = 0.06;

const point = (r: number, a: number) => {
  const c = PIE.size / 2;
  return { x: c + r * Math.sin(a), y: c - r * Math.cos(a) };
};
const fmt = (n: number) => Math.round(n * 100) / 100;

/** A ring segment from angle a0 to a1 (radians, clockwise from twelve o'clock). */
function ringPath(a0: number, a1: number): string {
  const { outer, inner } = PIE;
  // A whole ring can't be one arc: two halves.
  if (a1 - a0 >= Math.PI * 2 - 1e-9) return ringPath(a0, a0 + Math.PI) + ' ' + ringPath(a0 + Math.PI, a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const o0 = point(outer, a0), o1 = point(outer, a1), i1 = point(inner, a1), i0 = point(inner, a0);
  return `M ${fmt(o0.x)} ${fmt(o0.y)} A ${outer} ${outer} 0 ${large} 1 ${fmt(o1.x)} ${fmt(o1.y)} `
    + `L ${fmt(i1.x)} ${fmt(i1.y)} A ${inner} ${inner} 0 ${large} 0 ${fmt(i0.x)} ${fmt(i0.y)} Z`;
}

export function pieSlices(b: Pick<ItemBreakdown, 'sold' | 'forSale' | 'noPrice' | 'noDescription' | 'notOnSale' | 'total'>): PieSlice[] {
  const total = b.total || 0;
  let at = 0;
  return KINDS.map((k) => {
    const count = b[k.key];
    if (!total || count === 0) return { ...k, count, path: '', labelAt: null };
    const span = (count / total) * Math.PI * 2;
    const slice: PieSlice = {
      ...k,
      count,
      path: ringPath(at, at + span),
      labelAt: count / total >= MIN_LABEL_FRACTION ? point((PIE.outer + PIE.inner) / 2, at + span / 2) : null,
    };
    at += span;
    return slice;
  });
}

export function percent(count: number, total: number): string {
  if (!total) return '0%';
  const p = (count / total) * 100;
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}
