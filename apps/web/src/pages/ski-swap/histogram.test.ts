import { describe, expect, it } from 'vitest';
import { histogram, median } from './histogram';

describe('histogram', () => {
  it('counts items into widening ranges, from the first that has any to the last', () => {
    expect(histogram([1, 1, 3, 7, 10, 12], 'items')).toEqual([
      { label: '1', count: 2 },
      { label: '2', count: 0 },
      { label: '3', count: 1 },
      { label: '4', count: 0 },
      { label: '5', count: 0 },
      { label: '6–10', count: 2 },
      { label: '11–20', count: 1 },
    ]);
    expect(histogram([1219], 'items')).toEqual([{ label: '1,001+', count: 1 }]);
  });

  it('keeps $0 apart, and puts a boundary in the range above it', () => {
    expect(histogram([0, 0, 2500, 4999], 'cents')).toEqual([
      { label: '$0', count: 2 },
      { label: '<$25', count: 0 },
      { label: '$25–50', count: 2 },
    ]);
  });

  it('splits a shop’s thousands, open-ended at $50k', () => {
    expect(histogram([1500000, 6000000], 'cents').map((b) => b.label)).toEqual(['$10k–25k', '$25k–50k', '$50k+']);
  });

  it('is empty with nothing to count', () => {
    expect(histogram([], 'items')).toEqual([]);
    expect(histogram([0], 'items')).toEqual([]);
  });
});

describe('median', () => {
  it('is the middle value, or the rounded mean of the middle two', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 6])).toBe(3);
    expect(median([])).toBe(0);
  });
});
