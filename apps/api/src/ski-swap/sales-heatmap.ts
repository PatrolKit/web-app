import type { PosSaleLine } from './pos/pos.adapter';
import { dayIn, hourIn } from './checkins-per-day';

/**
 * Sales by hour, and sold by category (Plan 46), from Square's sale lines.
 *
 * Only this swap's sales count (D2): a line whose variation is one of its
 * items', deleted and returned ones included, since a sale is a sale.
 * Anything else rung up at the location (concessions, another swap) is
 * left out.
 */

export interface SalesCell {
  /** YYYY-MM-DD, in the swap's time zone. */
  date: string;
  /** 0–23, in the swap's time zone. */
  hour: number;
  /** Units sold, less refunds. */
  units: number;
  /** What the register took, after discounts, less the refunded share. */
  cents: number;
}

export interface SalesHeatmapData {
  days: string[];
  hours: number[];
  cells: SalesCell[];
  totals: { units: number; cents: number };
}

/** A line's net units and money (D4): refunds come off both, pro rata. */
export function netOf(line: PosSaleLine): { units: number; cents: number } {
  const units = Math.max(0, line.quantity - line.refundedQuantity);
  const cents = line.quantity > 0 ? Math.round(line.collectedCents * (units / line.quantity)) : 0;
  return { units, cents };
}

export function salesHeatmap(lines: PosSaleLine[], variationIds: Set<string>, timeZone: string): SalesHeatmapData {
  const byKey = new Map<string, SalesCell>();
  const totals = { units: 0, cents: 0 };
  for (const line of lines) {
    if (!variationIds.has(line.variationId)) continue;
    const { units, cents } = netOf(line);
    if (units === 0 && cents === 0) continue;
    const date = dayIn(line.soldAt, timeZone);
    const hour = hourIn(line.soldAt, timeZone);
    const key = `${date} ${hour}`;
    const cell = byKey.get(key) ?? { date, hour, units: 0, cents: 0 };
    cell.units += units;
    cell.cents += cents;
    byKey.set(key, cell);
    totals.units += units;
    totals.cents += cents;
  }
  const cells = [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
  return {
    days: [...new Set(cells.map((c) => c.date))],
    hours: [...new Set(cells.map((c) => c.hour))].sort((a, b) => a - b),
    cells,
    totals,
  };
}

/**
 * Units sold per category (D6): each line to its item's current category,
 * null for an item with none. A line not in `categoryByVariation` isn't this
 * swap's and is left out.
 */
export function soldByCategory(lines: PosSaleLine[], categoryByVariation: Map<string, string | null>): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const line of lines) {
    if (!categoryByVariation.has(line.variationId)) continue;
    const category = categoryByVariation.get(line.variationId) ?? null;
    const { units } = netOf(line);
    if (units > 0) out.set(category, (out.get(category) ?? 0) + units);
  }
  return out;
}
