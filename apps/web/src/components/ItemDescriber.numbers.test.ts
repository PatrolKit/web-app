import { describe, expect, it } from 'vitest';
import { numberChoices, numberRanges } from './ItemDescriber';
import type { ResolvedAttribute } from '../lib/api.types';

/**
 * Every number question in the taxonomy, as the seed actually configures them.
 * These are the inputs the range splitter has to be sensible for; a change that
 * makes a ski length read 210–219, or strands 215 in a range of its own, fails
 * here rather than on a phone at a swap.
 */
const attr = (min: number, max: number, step: number): ResolvedAttribute => ({
  id: 'x', label: 'x', scope: 'global', input: 'number', displayOrder: 0,
  nameSlot: null, min, max, step,
});

const REAL = {
  'ski length':       attr(70, 215, 1),
  'waist width':      attr(60, 140, 1),
  'snowboard length': attr(90, 185, 1),
  mondopoint:         attr(14, 34, 0.5),
  flex:               attr(30, 140, 5),
  'boot size':        attr(1, 16, 0.5),
  'pole length':      attr(100, 215, 5),
  'kayak length':     attr(5, 22, 0.5),
  speeds:             attr(1, 33, 1),
};

describe('numberChoices', () => {
  it('enumerates a bounded question on its step', () => {
    expect(numberChoices(attr(70, 75, 1))).toEqual(['70', '71', '72', '73', '74', '75']);
  });

  it('does not let a half step print as 12.000000000000002', () => {
    expect(numberChoices(attr(14, 16, 0.5))).toEqual(['14', '14.5', '15', '15.5', '16']);
  });

  it('gives up on a question with no bounds, leaving it a text field', () => {
    expect(numberChoices({ ...attr(0, 0, 0), min: undefined, max: undefined, step: undefined })).toBeNull();
    expect(numberChoices(attr(0, 100000, 1))).toBeNull();
  });
});

describe('numberRanges', () => {
  it('leaves a short question as one row of chips', () => {
    for (const a of [REAL.flex, REAL['pole length'], attr(70, 140, 5)]) {
      expect(numberRanges(numberChoices(a)!)).toBeNull();
    }
  });

  it('splits a ski length into decades ending on the real last value', () => {
    const ranges = numberRanges(numberChoices(REAL['ski length'])!)!;
    expect(ranges).not.toBeNull();
    expect(ranges[0].label).toBe('70–79');
    expect(ranges[ranges.length - 1].label).toBe('210–215');
    expect(ranges.find((r) => r.label === '170–179')!.values).toContain('172');
  });

  it.each(Object.entries(REAL))('keeps %s whole, even and tappable', (_name, a) => {
    const choices = numberChoices(a)!;
    const ranges = numberRanges(choices);
    if (ranges === null) {
      expect(choices.length).toBeLessThanOrEqual(24);
      return;
    }
    // Every legal value is reachable, exactly once and in order.
    expect(ranges.flatMap((r) => r.values)).toEqual(choices);
    // Neither the ranges nor the values inside one become a wall of chips.
    expect(ranges.length).toBeLessThanOrEqual(20);
    for (const r of ranges) expect(r.values.length).toBeLessThanOrEqual(20);
    // No range is left holding one stray value beside ranges of ten.
    const full = Math.max(...ranges.map((r) => r.values.length));
    for (const r of ranges) expect(r.values.length).toBeGreaterThanOrEqual(full / 2);
    // A label says what is in it.
    for (const r of ranges) {
      const [first, last] = [r.values[0], r.values[r.values.length - 1]];
      expect(r.label).toBe(first === last ? first : `${first}–${last}`);
    }
  });
});
