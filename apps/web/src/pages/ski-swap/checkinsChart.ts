/**
 * The check-ins-per-day chart's layout (kept apart from the component so it
 * can be tested): one stacked bar per day, individuals at the bottom and
 * businesses on top, each part shown only when its toggle is on.
 */

import type { CheckinDay } from '../../lib/api.types';

export type { CheckinDay };

export interface Shown {
  individual: boolean;
  business: boolean;
}

export interface Bar {
  date: string;
  /** "Oct 4"; null where the axis has no room for every day. */
  label: string | null;
  x: number;
  width: number;
  total: number;
  segments: { kind: 'individual' | 'business'; y: number; height: number; count: number }[];
}

/** Each day's slot is this wide at least; a long swap scrolls sideways. */
export const CHART = { height: 200, top: 20, bottom: 24, left: 34, slot: 30, gap: 8, minWidth: 560, maxBar: 64 };

/** A round top for the scale: 7 → 10, 23 → 25, 140 → 200. */
export function niceMax(n: number): number {
  if (n <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= n) return m * pow;
  return 10 * pow;
}

export function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** `fitWidth`: the card's width, which a short swap's days spread across. */
export function chartLayout(days: CheckinDay[], shown: Shown, fitWidth: number = CHART.minWidth) {
  const totals = days.map((d) => (shown.individual ? d.individual : 0) + (shown.business ? d.business : 0));
  const yMax = niceMax(Math.max(0, ...totals));
  const plotH = CHART.height - CHART.top - CHART.bottom;
  const slot = Math.max(CHART.slot, (Math.max(fitWidth, CHART.minWidth) - CHART.left) / Math.max(1, days.length));
  const width = CHART.left + slot * days.length;
  // About one date label per 60 px.
  const every = Math.max(1, Math.ceil(60 / slot));
  const scale = (n: number) => (n / yMax) * plotH;
  const baseline = CHART.height - CHART.bottom;

  const bars: Bar[] = days.map((d, i) => {
    let y = baseline;
    const segments: Bar['segments'] = [];
    for (const kind of ['individual', 'business'] as const) {
      if (!shown[kind] || d[kind] === 0) continue;
      const height = scale(d[kind]);
      y -= height;
      segments.push({ kind, y, height, count: d[kind] });
    }
    // A few days across a wide card: bars stay a sensible width, centred in their slot.
    const width = Math.min(slot - CHART.gap, CHART.maxBar);
    return {
      date: d.date,
      label: i % every === 0 ? dayLabel(d.date) : null,
      x: CHART.left + i * slot + (slot - width) / 2,
      width,
      total: totals[i],
      segments,
    };
  });

  return { width, yMax, ticks: [0, yMax / 2, yMax], tickY: (n: number) => baseline - scale(n), bars, baseline };
}
