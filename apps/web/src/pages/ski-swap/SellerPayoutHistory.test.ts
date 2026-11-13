import { describe, expect, it } from 'vitest';
import { byText, changeText } from './SellerPayoutHistory';
import type { PayoutChangeView } from '../../lib/api.types';

const change = (o: Partial<PayoutChangeView>): PayoutChangeView => ({
  at: '2026-11-13T15:00:00Z', via: 'staff', by: 'Alex Smith', from: null, to: { method: 'PAYPAL', destination: 'dana@example.com' }, ...o,
});

describe('a payout change in words', () => {
  it('says what it was and what it became', () => {
    expect(changeText(change({ from: { method: 'PAYPAL', destination: 'dana@example.com' }, to: { method: 'CHECK', destination: '12 Main St, Stowe, VT 05672' } })))
      .toBe('PayPal (dana@example.com) → Check (12 Main St, Stowe, VT 05672)');
  });
  it('a first choice is set, and donating goes nowhere', () => {
    expect(changeText(change({}))).toBe('Set to PayPal (dana@example.com)');
    expect(changeText(change({ from: { method: 'CHECK', destination: null }, to: { method: 'DONATE', destination: null } }))).toBe('Check → Donate');
  });
  it('says who made it, and how', () => {
    expect(byText(change({}))).toBe('by Alex Smith');
    expect(byText(change({ via: 'tablet', by: 'Counter iPad 3' }))).toBe('on Counter iPad 3');
    expect(byText(change({ via: 'seller', by: 'Dana Reyes' }))).toBe('by the seller');
    expect(byText(change({ via: 'merge' }))).toBe('by Alex Smith, merging sellers');
    expect(byText(change({ by: null }))).toBe('by staff');
  });
});
