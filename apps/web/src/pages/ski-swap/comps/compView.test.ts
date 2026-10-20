import { describe, expect, it } from 'vitest';
import { COMP_REASONS, compReasonLabel, sellerGets } from './compView';

describe('comps (Plan 53)', () => {
  it('has the four reasons, in words', () => {
    expect(COMP_REASONS.map((r) => r.label)).toEqual(['Paid outside Square', 'Sold, no sale found', 'Lost or damaged', 'Other']);
    expect(compReasonLabel('LOST')).toBe('Lost or damaged');
  });

  it('pays the seller the list price less the patrol’s share, rounded once', () => {
    expect(sellerGets(6000, 1, 2000)).toBe(4800);
    expect(sellerGets(4500, 1, 2000)).toBe(3600);
    expect(sellerGets(1999, 1, 2000)).toBe(1599);
  });
});
