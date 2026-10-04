import { describe, expect, it } from 'vitest';
import { deriveSwapSlug, SWAP_SLUG_PATTERN, swapStatusUrl } from './swapSlug';

/** The dialog previews what the server will make (Plan 33), so the two must agree. */
describe('a swap’s slug, as the dialog previews it', () => {
  it('matches the server’s derivation', () => {
    expect(deriveSwapSlug('Ski Swap 2026')).toBe('ss26');
    expect(deriveSwapSlug('The Fall Sale of 2025')).toBe('fs25');
    expect(deriveSwapSlug('')).toBe('sk');
  });

  it('is always a valid slug', () => {
    for (const title of ['Ski Swap 2026', 'Bolton Valley Ski & Snowboard Sale 2026', '2026', '!!!']) {
      expect(SWAP_SLUG_PATTERN.test(deriveSwapSlug(title))).toBe(true);
    }
  });

  it('makes the status page’s address', () => {
    expect(swapStatusUrl('https://skiswap.patrolkit.io/', 'bmbwavsp', 'ss26'))
      .toBe('https://skiswap.patrolkit.io/bmbwavsp/ss26/status');
  });
});
