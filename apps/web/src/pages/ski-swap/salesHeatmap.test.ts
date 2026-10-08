import { describe, expect, it } from 'vitest';
import { money, salesView } from './salesHeatmap';

const map = {
  cells: [
    { date: '2026-10-10', hour: 9, units: 4, cents: 21000 },
    { date: '2026-10-10', hour: 10, units: 1, cents: 4500 },
    { date: '2026-10-11', hour: 9, units: 2, cents: 15050 },
  ],
};

describe('Sales by hour (Plan 46)', () => {
  it('reads units for items, and their totals', () => {
    const v = salesView(map, 'items');
    expect([v.value('2026-10-10', 9), v.value('2026-10-11', 10)]).toEqual([4, 0]);
    expect([v.dayTotal('2026-10-10'), v.hourTotal(9), v.total, v.max]).toEqual([5, 6, 7, 4]);
  });

  it('reads cents for dollars', () => {
    const v = salesView(map, 'dollars');
    expect([v.hourTotal(9), v.total, v.max]).toEqual([36050, 40550, 21000]);
  });

  it('formats whole dollars in cells and cents in tooltips', () => {
    expect(money(124050)).toBe('$1,241');
    expect(money(124050, true)).toBe('$1,240.50');
    expect(money(0)).toBe('$0');
  });
});
