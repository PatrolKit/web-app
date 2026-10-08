import { describe, expect, it } from 'vitest';
import type { CheckinsHeatmap } from '../../lib/api.types';
import { heatView } from './checkinsHeatmap';
import { dayLabel, hourLabel, opacity } from './heatmapParts';

// Two individuals (0, 1) and a shop (2). Ann (0) checks in at 2 pm and 3 pm.
const map: CheckinsHeatmap = {
  timeZone: 'America/New_York',
  days: ['2026-10-05', '2026-10-06'],
  hours: [14, 15],
  sellers: [{ business: false }, { business: false }, { business: true }],
  cells: [
    { date: '2026-10-05', hour: 14, individual: 10, business: 500, sellers: [0, 2] },
    { date: '2026-10-05', hour: 15, individual: 4, business: 0, sellers: [0, 1] },
    { date: '2026-10-06', hour: 14, individual: 6, business: 0, sellers: [1] },
  ],
};
const both = { individual: true, business: true };

describe('the check-ins heat map', () => {
  it('counts items per hour, per day and in all', () => {
    const v = heatView(map, 'items', both);
    expect([v.value('2026-10-05', 14), v.value('2026-10-06', 15)]).toEqual([510, 0]);
    expect([v.dayTotal('2026-10-05'), v.hourTotal(14), v.total, v.max]).toEqual([514, 516, 520, 510]);
  });

  it('counts each seller once, wherever hours are added up', () => {
    const v = heatView(map, 'sellers', both);
    expect(v.value('2026-10-05', 14)).toBe(2);
    expect(v.dayTotal('2026-10-05')).toBe(3);   // Ann once, though she came at 2 and 3
    expect(v.hourTotal(14)).toBe(3);
    expect(v.total).toBe(3);
  });

  it('leaves out what a toggle hides', () => {
    const items = heatView(map, 'items', { individual: true, business: false });
    expect(items.value('2026-10-05', 14)).toBe(10);
    const sellers = heatView(map, 'sellers', { individual: false, business: true });
    expect([sellers.value('2026-10-05', 15), sellers.total]).toEqual([0, 1]);
  });

  it('gives each chip the whole swap’s count of its kind', () => {
    expect(heatView(map, 'items', both).kindTotals).toEqual({ individual: 20, business: 500 });
    expect(heatView(map, 'sellers', both).kindTotals).toEqual({ individual: 2, business: 1 });
  });

  it('fades by square root, never fully clear for a non-zero hour', () => {
    expect(opacity(0, 100)).toBe(0);
    expect(opacity(100, 100)).toBe(1);
    expect(opacity(25, 100)).toBe(0.56);
    expect(opacity(1, 500)).toBeGreaterThan(0.12);
  });

  it('labels hours and days', () => {
    expect([hourLabel(0), hourLabel(9), hourLabel(12), hourLabel(19)]).toEqual(['12 am', '9 am', '12 pm', '7 pm']);
    expect(dayLabel('2026-10-05')).toBe('Oct 5');
  });
});
