import { describe, expect, it } from 'vitest';
import { columns, sums } from './categoriesChart';

const counts = [
  { categoryId: 'skis', label: 'Skis', count: 112 },
  { categoryId: 'boots', label: 'Ski boots', count: 40 },
];

describe('Items by category, with sold (Plan 46 D6)', () => {
  it('joins sold to each category, 0 for none sold', () => {
    const cols = columns(counts, [{ categoryId: 'skis', units: 38 }, { categoryId: null, units: 9 }]);
    expect(cols.map((c) => [c.categoryId, c.sold, c.total])).toEqual([['skis', 38, 112], ['boots', 0, 40]]);
    expect(sums(cols)).toEqual({ total: 152, sold: 38 });
  });

  it('never draws sold past the column', () => {
    expect(columns(counts, [{ categoryId: 'boots', units: 41 }])[1].sold).toBe(40);
  });

  it('has no sold layer when Square couldn’t be read', () => {
    const cols = columns(counts, null);
    expect(cols.every((c) => c.sold === null)).toBe(true);
    expect(sums(cols)).toEqual({ total: 152, sold: null });
  });
});
