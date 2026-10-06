import { describe, expect, it } from 'vitest';
import { CHART, chartLayout, dayLabel, niceMax } from './checkinsChart';

const days = [
  { date: '2026-10-02', individual: 10, business: 30 },
  { date: '2026-10-03', individual: 0, business: 0 },
  { date: '2026-10-04', individual: 25, business: 5 },
];

describe('the check-ins chart', () => {
  it('rounds the scale up to a tidy number', () => {
    expect([niceMax(0), niceMax(7), niceMax(23), niceMax(40), niceMax(140)]).toEqual([1, 10, 25, 50, 200]);
  });

  it('stacks individuals under businesses, with the day’s total', () => {
    const { bars } = chartLayout(days, { individual: true, business: true });
    expect(bars.map((b) => b.total)).toEqual([40, 0, 30]);
    expect(bars[0].segments.map((s) => [s.kind, s.count])).toEqual([['individual', 10], ['business', 30]]);
    expect(bars[0].segments[1].y).toBeLessThan(bars[0].segments[0].y);
  });

  it('keeps an empty day as a space with no bar', () => {
    const { bars } = chartLayout(days, { individual: true, business: true });
    expect(bars[1]).toMatchObject({ date: '2026-10-03', total: 0, segments: [] });
  });

  it('leaves out what a toggle hides, totals and scale included', () => {
    const { bars, yMax } = chartLayout(days, { individual: true, business: false });
    expect(bars.map((b) => b.total)).toEqual([10, 0, 25]);
    expect(bars[0].segments.map((s) => s.kind)).toEqual(['individual']);
    expect(yMax).toBe(25);
  });

  it('gives a long swap room, and labels only some days', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, individual: 1, business: 0 }));
    const { width, bars } = chartLayout(many, { individual: true, business: true });
    expect(width).toBe(CHART.left + CHART.slot * 60);
    expect(bars.filter((b) => b.label).length).toBeLessThan(60);
  });

  it('writes a day as month and date', () => {
    expect(dayLabel('2026-10-04')).toBe('Oct 4');
  });
});
