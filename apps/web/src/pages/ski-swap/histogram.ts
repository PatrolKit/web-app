/**
 * The dashboard's histograms (sellers and buyers), kept apart from the cards
 * so they can be tested: how many sellers or checkouts fall in each range of
 * items or dollars.
 *
 * The ranges widen as they climb, because the spread is wide: most sellers
 * bring a few items and a shop brings hundreds.
 */

export interface Bin {
  label: string;
  /** How many sellers or checkouts fall in it. */
  count: number;
}

interface Range {
  from: number;
  /** Exclusive; null is open-ended. */
  to: number | null;
  label: string;
}

const ITEM_RANGES: Range[] = [
  { from: 1, to: 2, label: '1' },
  { from: 2, to: 3, label: '2' },
  { from: 3, to: 4, label: '3' },
  { from: 4, to: 5, label: '4' },
  { from: 5, to: 6, label: '5' },
  { from: 6, to: 11, label: '6–10' },
  { from: 11, to: 21, label: '11–20' },
  { from: 21, to: 51, label: '21–50' },
  { from: 51, to: 101, label: '51–100' },
  { from: 101, to: 251, label: '101–250' },
  { from: 251, to: 501, label: '251–500' },
  { from: 501, to: 1001, label: '501–1,000' },
  { from: 1001, to: null, label: '1,001+' },
];

/** In cents. $0 is its own range: a seller who has sold nothing. */
const DOLLAR_RANGES: Range[] = [
  { from: 0, to: 1, label: '$0' },
  { from: 1, to: 2500, label: '<$25' },
  { from: 2500, to: 5000, label: '$25–50' },
  { from: 5000, to: 10000, label: '$50–100' },
  { from: 10000, to: 25000, label: '$100–250' },
  { from: 25000, to: 50000, label: '$250–500' },
  { from: 50000, to: 100000, label: '$500–1k' },
  { from: 100000, to: 250000, label: '$1k–2.5k' },
  { from: 250000, to: 500000, label: '$2.5k–5k' },
  { from: 500000, to: 1000000, label: '$5k–10k' },
  { from: 1000000, to: 2500000, label: '$10k–25k' },
  { from: 2500000, to: 5000000, label: '$25k–50k' },
  { from: 5000000, to: null, label: '$50k+' },
];

/**
 * The values counted into ranges, from the first that has any to the last:
 * empty ranges between them stay, so the gaps show.
 */
export function histogram(values: number[], kind: 'items' | 'cents'): Bin[] {
  const ranges = kind === 'items' ? ITEM_RANGES : DOLLAR_RANGES;
  const counts = ranges.map(() => 0);
  for (const v of values) {
    const i = ranges.findIndex((r) => v >= r.from && (r.to === null || v < r.to));
    if (i !== -1) counts[i] += 1;
  }
  const first = counts.findIndex((c) => c > 0);
  if (first === -1) return [];
  const last = counts.length - 1 - [...counts].reverse().findIndex((c) => c > 0);
  return ranges.slice(first, last + 1).map((r, i) => ({ label: r.label, count: counts[first + i] }));
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function sum(values: number[]): number {
  return values.reduce((n, v) => n + v, 0);
}
