import { payoutGaps, type PayoutGapSeller } from './payout-gaps';

const payable: PayoutGapSeller = {
  email: 'dana@example.com', emailVerifiedAt: '2026-10-01T00:00:00.000Z',
  street: '1 Main St', city: 'Stowe', state: 'VT', zip: '05672',
  payoutMethod: 'CHECK', payoutTarget: null, payoutHandleScanned: false,
};
const keys = (s: Partial<PayoutGapSeller>) => payoutGaps({ ...payable, ...s }).map((g) => g.key);

describe('payoutGaps', () => {
  it('finds nothing wrong with a check, a donation, a verified PayPal email or a scanned Venmo', () => {
    expect(keys({})).toEqual([]);
    expect(keys({ payoutMethod: 'DONATE' })).toEqual([]);
    expect(keys({ payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL' })).toEqual([]);
    expect(keys({ payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID', payoutHandleScanned: true })).toEqual([]);
  });

  it('names the missing parts of an address, or the whole of it', () => {
    expect(payoutGaps({ ...payable, zip: null, state: '' })[0].problem).toBe('Address has no state and ZIP code');
    expect(payoutGaps({ ...payable, street: null, city: null, state: null, zip: null })[0].problem).toBe('No mailing address');
  });

  it('flags no method, and the payouts the run won’t send (Plan 35)', () => {
    expect(keys({ payoutMethod: null })).toEqual(['NO_METHOD']);
    expect(keys({ payoutMethod: 'PAYPAL', payoutTarget: 'PHONE' })).toEqual(['PAYPAL_NOT_EMAIL']);
    expect(keys({ payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL', email: null })).toEqual(['PAYPAL_NO_EMAIL']);
    expect(keys({ payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL', emailVerifiedAt: null })).toEqual(['PAYPAL_UNVERIFIED']);
    expect(keys({ payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID' })).toEqual(['VENMO_UNSCANNED']);
  });

  it('lists every gap, each with a fix', () => {
    const gaps = payoutGaps({ ...payable, zip: null, payoutMethod: null });
    expect(gaps.map((g) => g.key)).toEqual(['ADDRESS', 'NO_METHOD']);
    expect(gaps.every((g) => g.fix.length > 0)).toBe(true);
  });
});
