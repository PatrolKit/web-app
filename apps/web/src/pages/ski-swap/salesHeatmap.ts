import type { SalesCell, SalesHeatmap } from '../../lib/api.types';

/**
 * Sales by hour's numbers (Plan 46 D4), kept apart from the card so they can
 * be tested: units sold or dollars taken, per hour, with the day and hour
 * totals the grid shows.
 */

export type SalesKind = 'items' | 'dollars';

export interface SalesView {
  value: (date: string, hour: number) => number;
  dayTotal: (date: string) => number;
  hourTotal: (hour: number) => number;
  total: number;
  max: number;
}

export function salesView(map: Pick<SalesHeatmap, 'cells'>, kind: SalesKind): SalesView {
  const of = (c: SalesCell) => (kind === 'items' ? c.units : c.cents);
  const byKey = new Map(map.cells.map((c) => [`${c.date} ${c.hour}`, of(c)]));
  const sum = (cells: SalesCell[]) => cells.reduce((n, c) => n + of(c), 0);
  return {
    value: (date, hour) => byKey.get(`${date} ${hour}`) ?? 0,
    dayTotal: (date) => sum(map.cells.filter((c) => c.date === date)),
    hourTotal: (hour) => sum(map.cells.filter((c) => c.hour === hour)),
    total: sum(map.cells),
    max: Math.max(0, ...map.cells.map(of)),
  };
}

/** "$1,240" in a cell; "$1,240.50" in a tooltip. */
export function money(cents: number, exact = false): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: exact ? 2 : 0, maximumFractionDigits: exact ? 2 : 0,
  });
}
