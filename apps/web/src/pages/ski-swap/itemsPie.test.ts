import { describe, expect, it } from 'vitest';
import { percent, pieSlices } from './itemsPie';

describe('the dashboard pie', () => {
  it('draws a slice per kind, in order, skipping empty ones', () => {
    const slices = pieSlices({ sold: 45, returned: 5, forSale: 30, noPrice: 15, noDescription: 5, notOnSale: 0, total: 100 });
    expect(slices.map((s) => [s.key, s.count, s.path !== ''])).toEqual([
      ['sold', 45, true], ['returned', 5, true], ['forSale', 30, true], ['noPrice', 15, true], ['noDescription', 5, true], ['notOnSale', 0, false],
    ]);
  });

  it('labels a slice on itself only when it’s wide enough', () => {
    const slices = pieSlices({ sold: 97, forSale: 3, noPrice: 0, noDescription: 0, notOnSale: 0, total: 100 });
    expect(slices[0].labelAt).not.toBeNull();
    expect(slices[1].labelAt).toBeNull();
  });

  it('draws a single kind as a whole ring', () => {
    const [sold] = pieSlices({ sold: 5, forSale: 0, noPrice: 0, noDescription: 0, notOnSale: 0, total: 5 });
    expect(sold.path.match(/M /g)).toHaveLength(2);
  });

  it('draws nothing for no items', () => {
    expect(pieSlices({ sold: 0, forSale: 0, noPrice: 0, noDescription: 0, notOnSale: 0, total: 0 }).every((s) => s.path === '')).toBe(true);
  });

  it('rounds percentages, never to zero', () => {
    expect(percent(1, 3)).toBe('33%');
    expect(percent(1, 400)).toBe('<1%');
    expect(percent(0, 0)).toBe('0%');
  });
});
