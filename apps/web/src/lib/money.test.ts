import { describe, expect, it } from 'vitest';
import { itemPrice, PRICE_TO_COME } from './money';
import { formatCents } from '../pages/checkin/shared';

describe('an item’s price on screen', () => {
  it('reads as money when there is one', () => {
    expect(itemPrice(4500)).toBe('$45.00');
    expect(formatCents(4500)).toBe('$45.00');
  });

  it('says the price is to come, never $0.00, for a ticket not yet priced (Plan 32)', () => {
    expect(itemPrice(null)).toBe(PRICE_TO_COME);
    expect(formatCents(null)).toBe('Price to come');
  });
});
