import { describe, expect, it } from 'vitest';
import { itemSegments, percent } from './itemsPie';

describe('the dashboard’s Items bar', () => {
  it('has a segment per kind, in order, each its share of the bar', () => {
    const segs = itemSegments({ sold: 45, returned: 5, forSale: 30, noPrice: 15, noDescription: 5, notOnSale: 0, total: 100 });
    expect(segs.map((s) => [s.key, s.count, s.width])).toEqual([
      ['sold', 45, '45%'], ['returned', 5, '5%'], ['forSale', 30, '30%'], ['noPrice', 15, '15%'], ['noDescription', 5, '5%'], ['notOnSale', 0, '0%'],
    ]);
  });

  it('reads no returned from an older server as none', () => {
    expect(itemSegments({ sold: 1, forSale: 1, noPrice: 0, noDescription: 0, notOnSale: 0, total: 2 })[1].count).toBe(0);
  });

  it('draws nothing for no items', () => {
    expect(itemSegments({ sold: 0, forSale: 0, noPrice: 0, noDescription: 0, notOnSale: 0, total: 0 }).every((s) => s.width === '0%')).toBe(true);
  });

  it('rounds percentages, never to zero', () => {
    expect(percent(1, 3)).toBe('33%');
    expect(percent(1, 400)).toBe('<1%');
    expect(percent(0, 0)).toBe('0%');
  });
});
