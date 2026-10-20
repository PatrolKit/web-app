import { activeKeyOf, allFinal, flagsFor, gapsForPayout, issuesBySeller, issueText, kindOf } from './payout-flags';
import type { PayoutGapSeller } from '../../contracts/payout-gaps';
import type { SalesCheckIssue } from '../../contracts/sales-check.contracts';

const seller = (over: Partial<PayoutGapSeller> = {}): PayoutGapSeller => ({
  email: 'dana@example.com', emailVerifiedAt: '2026-10-01T00:00:00Z',
  street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672',
  payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL', payoutHandleScanned: false, ...over,
});

const issue = (over: Partial<SalesCheckIssue>): SalesCheckIssue => ({
  key: 'k', kind: 'custom_amount', orderId: 'o1', lineUid: 'l1', soldAt: '2026-10-10T14:00:00Z',
  quantity: 1, refundedQuantity: 0, collectedCents: 2500, unitPriceCents: 2500, rungUpAs: null,
  suggestion: null, ticket: null, categoryIds: [], links: { sale: null, item: null }, receipt: 'Gq7K', ...over,
});

const base = { kind: 'PAYPAL' as const, method: 'PAYPAL' as const, gaps: [], issues: [], unpriced: [], held: [], netCents: 5000 };

describe('what an issue says on a seller’s card', () => {
  it('says how many times a ticket sold across sales, and how many were checked in', () => {
    const oversold = { itemId: 'i', sku: '87025', name: 'Boots', sellerName: null, priceCents: 8900, units: 2, quantity: 1, orders: ['8p', 'mY'], sales: [] };
    expect(issueText({ kind: 'oversold', oversold } as never)).toBe('Sold 2 times in different sales; checked in 1');
  });
});

describe('kindOf (D1)', () => {
  it('pays PayPal and Venmo in a PayPal run, checks in a check run, and Donate in neither', () => {
    expect([kindOf('PAYPAL'), kindOf('VENMO'), kindOf('CHECK'), kindOf('DONATE'), kindOf(null)]).toEqual(['PAYPAL', 'PAYPAL', 'CHECK', null, null]);
  });
});

describe('gapsForPayout (D16)', () => {
  it('doesn’t need an address to pay through PayPal', () => {
    expect(gapsForPayout(seller({ street: null, city: null, state: null, zip: null }))).toEqual([]);
  });

  it('needs an address for a check', () => {
    expect(gapsForPayout(seller({ payoutMethod: 'CHECK', zip: null })).map((g) => g.key)).toEqual(['ADDRESS']);
  });

  it('needs a verified PayPal email, and a scanned Venmo', () => {
    expect(gapsForPayout(seller({ emailVerifiedAt: null })).map((g) => g.key)).toEqual(['PAYPAL_UNVERIFIED']);
    expect(gapsForPayout(seller({ payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID' })).map((g) => g.key)).toEqual(['VENMO_UNSCANNED']);
  });

  it('asks a seller with no method only to choose one, and a donor for nothing', () => {
    expect(gapsForPayout(seller({ payoutMethod: null, street: null })).map((g) => g.key)).toEqual(['NO_METHOD']);
    expect(gapsForPayout(seller({ payoutMethod: 'DONATE', street: null }))).toEqual([]);
  });
});

describe('issuesBySeller (D8, D14)', () => {
  const items = [{ id: 'i1', sku: '74566', sellerId: 's1' }, { id: 'i2', sku: '75352', sellerId: 's2' }];

  it('puts each issue on the seller it bears on, by item or ticket', () => {
    const { bySeller, unmatched } = issuesBySeller([
      issue({ kind: 'price_paid', paid: { itemId: 'i1', sku: '74566', name: 'Helmet', sellerName: 'Dana', sellerId: 's1', priceCents: 4200, rungCents: 2400, paidCents: 2400 } }),
      issue({ kind: 'other_copy', ticket: '75352' }),
    ], items);
    expect(bySeller.get('s1')).toEqual([{ sku: '74566', kind: 'price_paid', text: 'Sold for $24.00; PatrolKit says $42.00' }]);
    expect(bySeller.get('s2')).toEqual([{ sku: '75352', kind: 'other_copy', text: 'Another copy of this ticket was rung up' }]);
    expect(unmatched).toEqual([]);
  });

  it('keeps a sale that names no seller as unmatched, and ignores fee checks', () => {
    const { bySeller, unmatched } = issuesBySeller([issue({ kind: 'custom_amount' }), issue({ kind: 'double_fee' })], items);
    expect(bySeller.size).toBe(0);
    expect(unmatched.map((i) => i.kind)).toEqual(['custom_amount']);
  });
});

describe('flagsFor (D8)', () => {
  it('flags nothing for a seller who can be paid', () => {
    expect(flagsFor(base)).toEqual([]);
  });

  it('flags a seller whose method changed to another kind of run', () => {
    expect(flagsFor({ ...base, method: 'CHECK' })[0].text).toBe('Wrong run: now paid by Check');
  });

  it('says how to fix a price paid, and lists each issue with its ticket', () => {
    const flags = flagsFor({ ...base, issues: [{ sku: '74566', kind: 'price_paid', text: 'Sold for $24.00; PatrolKit says $42.00' }] });
    expect(flags).toEqual([{ text: '74566: Sold for $24.00; PatrolKit says $42.00', fix: 'In Sales check, keep PatrolKit’s price or set it from the sale.' }]);
  });

  it('flags held and unpriced sales once, not again when Sales check already shows them', () => {
    expect(flagsFor({ ...base, held: ['75352'], issues: [{ sku: '75352', kind: 'oversold', text: 'Rung up 2 times; checked in 1' }] })).toHaveLength(1);
    expect(flagsFor({ ...base, held: ['75352'], unpriced: ['80645'] }).map((f) => f.text)).toEqual(['75352: counted as sold twice', '80645: sold with no price']);
  });

  it('flags a seller owed nothing', () => {
    expect(flagsFor({ ...base, netCents: 0 }).map((f) => f.text)).toEqual(['Nothing owed']);
  });
});

describe('closing and freeing (D4, D15, D19)', () => {
  it('closes a PayPal run once every payment is paid, failed, returned or cancelled', () => {
    expect(allFinal(['SENT', 'FAILED', 'RETURNED', 'CANCELLED'])).toBe(true);
    expect(allFinal(['SENT', 'UNCLAIMED'])).toBe(false);
    expect(allFinal(['SENT', 'ONHOLD'])).toBe(false);
    expect(allFinal([])).toBe(false);
  });

  it('keys a seller to one run of a swap at a time', () => {
    expect(activeKeyOf('swap1', 'seller1')).toBe('swap1:seller1');
  });
});
