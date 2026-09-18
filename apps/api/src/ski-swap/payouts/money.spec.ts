import {
  basisPointsToPercent, centsToDecimalString, percentToBasisPoints, splitCommission,
} from './money';

/**
 * Money, so this is exhaustive rather than representative. Every one of these
 * is a number somebody is paid.
 */
describe('percentToBasisPoints', () => {
  it('takes what a patrol would type', () => {
    expect(percentToBasisPoints('20')).toBe(2000);
    expect(percentToBasisPoints('20.5')).toBe(2050);
    expect(percentToBasisPoints('20.25')).toBe(2025);
    expect(percentToBasisPoints('0')).toBe(0);
    expect(percentToBasisPoints('100')).toBe(10_000);
    expect(percentToBasisPoints('20%')).toBe(2000);
    expect(percentToBasisPoints(' 20.5 ')).toBe(2050);
  });

  /**
   * The reason this rounds rather than truncates. `20.1 * 100` is
   * 2010.0000000000002, and `Math.trunc` of that is 2010 by luck rather than by
   * rule — a different value would land the other side.
   */
  it('survives the float it has to parse through', () => {
    expect(percentToBasisPoints('20.1')).toBe(2010);
    expect(percentToBasisPoints('8.7')).toBe(870);
    expect(percentToBasisPoints('29.7')).toBe(2970);
    expect(percentToBasisPoints('1.1')).toBe(110);
  });

  /** Two decimals is what basis points express. A third would be rounded away. */
  it('refuses a precision it cannot keep', () => {
    expect(percentToBasisPoints('20.555')).toBeNull();
    expect(percentToBasisPoints('0.001')).toBeNull();
  });

  it('refuses anything that is not a percentage', () => {
    for (const bad of ['', '-5', '101', 'twenty', '20.', '.5', '1e2', '20,5', 'NaN']) {
      expect(percentToBasisPoints(bad)).toBeNull();
    }
  });
});

describe('basisPointsToPercent', () => {
  it('does not show hundredths that were never typed', () => {
    expect(basisPointsToPercent(2000)).toBe('20%');
    expect(basisPointsToPercent(2050)).toBe('20.5%');
    expect(basisPointsToPercent(2025)).toBe('20.25%');
    expect(basisPointsToPercent(0)).toBe('0%');
    expect(basisPointsToPercent(10_000)).toBe('100%');
  });

  it('round-trips everything the input accepts', () => {
    for (let bps = 0; bps <= 10_000; bps += 1) {
      expect(percentToBasisPoints(basisPointsToPercent(bps))).toBe(bps);
    }
  });
});

describe('splitCommission', () => {
  it('splits the plan\'s own example', () => {
    expect(splitCommission(31_500, 2000)).toEqual({
      grossCents: 31_500, commissionCents: 6_300, netCents: 25_200,
    });
  });

  it('pays everything when there is no cut', () => {
    expect(splitCommission(31_500, 0)).toEqual({
      grossCents: 31_500, commissionCents: 0, netCents: 31_500,
    });
  });

  /** Half goes up, to the patrol. Written down so it cannot drift. */
  it('rounds the half cent to the patrol', () => {
    // 1 cent at 50% is half a cent.
    expect(splitCommission(1, 5000).commissionCents).toBe(1);
    expect(splitCommission(1, 5000).netCents).toBe(0);
    // 3 cents at 50% is one and a half.
    expect(splitCommission(3, 5000).commissionCents).toBe(2);
  });

  it('always adds back up', () => {
    for (const gross of [0, 1, 7, 99, 100, 12_345, 999_999]) {
      for (const bps of [0, 1, 250, 2000, 2050, 3333, 10_000]) {
        const s = splitCommission(gross, bps);
        expect(s.commissionCents + s.netCents).toBe(gross);
        expect(s.commissionCents).toBeGreaterThanOrEqual(0);
        expect(s.netCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  /**
   * The reason the split is applied to a seller's total rather than per item.
   * A hundred $9.99 items at 20% is 19980 cents of commission if you round
   * once, and can be several cents adrift if you round a hundred times.
   */
  it('does not drift when a seller has many items', () => {
    const items = Array.from({ length: 100 }, () => 999);
    const bps = 2000;
    const once = splitCommission(items.reduce((a, b) => a + b, 0), bps);
    const perItem = items.reduce((sum, c) => sum + splitCommission(c, bps).commissionCents, 0);

    expect(once.commissionCents).toBe(19_980);
    expect(perItem).toBe(20_000); // 20 cents adrift, in the patrol's favour
    expect(once.commissionCents).not.toBe(perItem);
  });

  it('refuses nonsense rather than paying on it', () => {
    expect(() => splitCommission(-1, 2000)).toThrow();
    expect(() => splitCommission(1.5, 2000)).toThrow();
    expect(() => splitCommission(100, 10_001)).toThrow();
    expect(() => splitCommission(100, -1)).toThrow();
  });
});

describe('centsToDecimalString', () => {
  /** A CSV a spreadsheet reads. No thousands separator, always two decimals. */
  it('writes what a spreadsheet will read back unchanged', () => {
    expect(centsToDecimalString(125_000)).toBe('1250.00');
    expect(centsToDecimalString(25_200)).toBe('252.00');
    expect(centsToDecimalString(5)).toBe('0.05');
    expect(centsToDecimalString(0)).toBe('0.00');
    expect(centsToDecimalString(-125)).toBe('-1.25');
  });
});
