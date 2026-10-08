import type { CheckinCell, CheckinsHeatmap } from '../../lib/api.types';

/**
 * The check-ins heat map's numbers (kept apart from the card so they can be
 * tested): items or sellers per hour, for the kinds of seller shown. Sellers
 * are counted once wherever cells are added up, so a seller who checked in
 * across three hours is one seller that day, not three.
 */

export type HeatKind = 'items' | 'sellers';
export interface Shown {
  individual: boolean;
  business: boolean;
}

export interface HeatView {
  value: (date: string, hour: number) => number;
  dayTotal: (date: string) => number;
  hourTotal: (hour: number) => number;
  total: number;
  max: number;
  /** For each toggle chip: the whole swap's count of that kind. */
  kindTotals: { individual: number; business: number };
}

export function heatView(map: CheckinsHeatmap, kind: HeatKind, shown: Shown): HeatView {
  const byKey = new Map(map.cells.map((c) => [`${c.date} ${c.hour}`, c]));
  const wanted = (business: boolean) => (business ? shown.business : shown.individual);
  const sellersIn = (cells: CheckinCell[], only?: boolean) => {
    const set = new Set<number>();
    for (const c of cells) for (const s of c.sellers) {
      const business = map.sellers[s]?.business ?? false;
      if (only === undefined ? wanted(business) : business === only) set.add(s);
    }
    return set.size;
  };
  const itemsIn = (cells: CheckinCell[]) =>
    cells.reduce((n, c) => n + (shown.individual ? c.individual : 0) + (shown.business ? c.business : 0), 0);
  const count = (cells: CheckinCell[]) => (kind === 'items' ? itemsIn(cells) : sellersIn(cells));

  const value = (date: string, hour: number) => {
    const c = byKey.get(`${date} ${hour}`);
    return c ? count([c]) : 0;
  };
  return {
    value,
    dayTotal: (date) => count(map.cells.filter((c) => c.date === date)),
    hourTotal: (hour) => count(map.cells.filter((c) => c.hour === hour)),
    total: count(map.cells),
    max: Math.max(0, ...map.cells.map((c) => count([c]))),
    kindTotals: kind === 'items'
      ? {
          individual: map.cells.reduce((n, c) => n + c.individual, 0),
          business: map.cells.reduce((n, c) => n + c.business, 0),
        }
      : { individual: sellersIn(map.cells, false), business: sellersIn(map.cells, true) },
  };
}
