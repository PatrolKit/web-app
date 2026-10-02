import { describe, expect, it } from 'vitest';
import { code39Modules } from './code39';

/**
 * The scanner test's legacy-ticket barcode. The vector was decoded as Code 39
 * "67169" by ZXing (zxing-cpp) from a render of this encoder's output, so it is
 * checked against a reader rather than against the table it came from.
 */
const VERIFIED_67169 = '100010111011101010111000111010101010001011101110111010001010111010111000111010101011100010111010100010111011101';

describe('code39Modules', () => {
  it('matches a render a real decoder read as 67169', () => {
    expect(code39Modules('67169').map((d) => (d ? '1' : '0')).join('')).toBe(VERIFIED_67169);
  });

  it('frames the number in start and stop characters', () => {
    // Each character is six narrow elements and three wide ones (6 + 3 × 3 = 15
    // modules), with a one-module gap between characters: *1* is 3 × 15 + 2.
    expect(code39Modules('1')).toHaveLength(3 * 15 + 2);
  });

  it('refuses anything but digits, which is all a ticket number is', () => {
    expect(() => code39Modules('A1')).toThrow();
  });
});
