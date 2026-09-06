import { countOf, hasAnyUnused, inAnyRange, suggestNext, ticketNumberOf } from './legacy-ticket.service';

/**
 * Spending a block of issued tickets.
 *
 * The whole feature turns on one distinction: the high-water mark decides what
 * is *suggested*, and never what is *allowed*. A pad is worked through in
 * order, tickets get lost and binned, and one that turns up later has to be
 * enterable — so the suggestion skips gaps while entry does not.
 */

const set = (...ns: number[]) => new Set(ns);

describe('reading a SKU as a ticket number', () => {
  it('takes a bare number', () => {
    expect(ticketNumberOf('67169')).toBe(67169);
  });

  it('refuses one of ours', () => {
    // Our own SKUs share the column, so anything shaped like SS26-A-0001 has to
    // read as "not a ticket" rather than as a number with punctuation.
    expect(ticketNumberOf('SS26-A-0001')).toBeNull();
    expect(ticketNumberOf('SS26-0042')).toBeNull();
  });

  it('refuses anything that is not only digits', () => {
    expect(ticketNumberOf('67169 ')).toBeNull();
    expect(ticketNumberOf('67-169')).toBeNull();
    expect(ticketNumberOf('')).toBeNull();
  });

  it('reads a number that is not zero-padded as itself', () => {
    // These pads are not padded, so 999 and 1000 are three and four digits and
    // both are ordinary numbers.
    expect(ticketNumberOf('999')).toBe(999);
    expect(ticketNumberOf('1000')).toBe(1000);
  });
});

describe('the suggested number', () => {
  const one = [{ startNumber: 67000, endNumber: 67004 }];

  it('opens at the bottom of the range when nothing is used', () => {
    expect(suggestNext(one, set())).toBe(67000);
  });

  it('walks down the pad', () => {
    expect(suggestNext(one, set(67000, 67001))).toBe(67002);
  });

  it('carries on past a binned ticket rather than offering it back', () => {
    // 67002 was binned. Suggesting it again on every item would make the
    // default something to correct rather than accept.
    expect(suggestNext(one, set(67000, 67001, 67003))).toBe(67004);
  });

  it('goes quiet at the top rather than reaching back into a gap', () => {
    expect(suggestNext(one, set(67000, 67001, 67003, 67004))).toBeNull();
  });

  it('rolls into the next range when one is exhausted', () => {
    const two = [
      { startNumber: 67000, endNumber: 67499 },
      { startNumber: 68000, endNumber: 68499 },
    ];
    expect(suggestNext(two, set(67499))).toBe(68000);
  });

  it('rolls even when the ranges were stored out of order', () => {
    const two = [
      { startNumber: 68000, endNumber: 68499 },
      { startNumber: 67000, endNumber: 67499 },
    ];
    expect(suggestNext(two, set(67000))).toBe(67001);
  });

  it('ignores numbers used outside this seller’s ranges', () => {
    // Another shop's tickets are in the same swap. Letting them raise this
    // seller's high-water mark would skip tickets they still hold.
    expect(suggestNext(one, set(90000, 67000))).toBe(67001);
  });

  it('has nothing to offer a seller with no ranges', () => {
    expect(suggestNext([], set())).toBeNull();
  });
});

describe('when a seller is actually out', () => {
  const one = [{ startNumber: 67000, endNumber: 67004 }];

  it('is not out merely because the suggestion has run dry', () => {
    // The binned 67002 is still unused, so the seller is not out — they are
    // one found ticket away from another item.
    const used = set(67000, 67001, 67003, 67004);
    expect(suggestNext(one, used)).toBeNull();
    expect(hasAnyUnused(one, used)).toBe(true);
  });

  it('is out only when every number is on an item', () => {
    expect(hasAnyUnused(one, set(67000, 67001, 67002, 67003, 67004))).toBe(false);
  });

  it('counts across every range they hold', () => {
    const two = [
      { startNumber: 67000, endNumber: 67001 },
      { startNumber: 68000, endNumber: 68001 },
    ];
    expect(hasAnyUnused(two, set(67000, 67001, 68000))).toBe(true);
    expect(hasAnyUnused(two, set(67000, 67001, 68000, 68001))).toBe(false);
  });
});

describe('membership of a range', () => {
  const two = [
    { startNumber: 67000, endNumber: 67499 },
    { startNumber: 68000, endNumber: 68499 },
  ];

  it('includes both ends', () => {
    expect(inAnyRange(67000, two)).toBe(true);
    expect(inAnyRange(67499, two)).toBe(true);
  });

  it('excludes the gap between two blocks', () => {
    expect(inAnyRange(67500, two)).toBe(false);
  });

  it('accepts a number below the high-water mark, which is the point', () => {
    // Nothing about membership consults what has been used. That is what lets
    // a found ticket be entered after the seller has worked past it.
    expect(inAnyRange(67002, two)).toBe(true);
  });
});

describe('how many tickets a block holds', () => {
  it('counts inclusively', () => {
    expect(countOf([{ startNumber: 67000, endNumber: 67499 }])).toBe(500);
  });

  it('counts a block of one', () => {
    expect(countOf([{ startNumber: 67000, endNumber: 67000 }])).toBe(1);
  });

  it('sums across blocks', () => {
    expect(
      countOf([
        { startNumber: 67000, endNumber: 67499 },
        { startNumber: 68000, endNumber: 68499 },
      ]),
    ).toBe(1000);
  });

  it('counts a block that crosses a digit-width boundary', () => {
    // 999 to 1005 is four three-digit numbers and three four-digit ones, and
    // nothing pads, so it is just seven.
    expect(countOf([{ startNumber: 999, endNumber: 1005 }])).toBe(7);
  });
});
