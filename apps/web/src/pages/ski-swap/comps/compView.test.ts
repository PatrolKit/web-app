import { describe, expect, it } from 'vitest';
import { COMP_REASONS, compReasonLabel } from './compView';

describe('comps (Plan 53)', () => {
  it('has the four reasons, in words', () => {
    expect(COMP_REASONS.map((r) => r.label)).toEqual(['Paid outside Square', 'Sold, no sale found', 'Lost or damaged', 'Other']);
    expect(compReasonLabel('LOST')).toBe('Lost or damaged');
  });
});
