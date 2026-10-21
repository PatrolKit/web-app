import { sellerMatches, sortSellers, type FilterableSeller } from './seller-filter';

const seller = (displayName: string, over: Partial<FilterableSeller> = {}): FilterableSeller => ({
  displayName, businessName: null, phone: null, email: null, payoutMethod: null, ...over,
});

describe('the Sellers page’s filter, shared with the export', () => {
  const dana = seller('Dana Reyes', { phone: '+18025550100', email: 'Dana@Example.com', payoutMethod: 'PAYPAL' });
  const shop = seller('Little Mountain', { businessName: 'Little Mountain', payoutMethod: 'CHECK' });
  const unset = seller('Sam Ortiz');

  it('searches name, phone and email, ignoring case', () => {
    expect([dana, shop, unset].filter((s) => sellerMatches(s, { search: 'dana@' }))).toEqual([dana]);
    expect([dana, shop, unset].filter((s) => sellerMatches(s, { search: '5550100' }))).toEqual([dana]);
    expect([dana, shop, unset].filter((s) => sellerMatches(s, { search: ' MOUNTAIN ' }))).toEqual([shop]);
  });

  it('filters by type, and by payout with “not set” for none', () => {
    expect([dana, shop, unset].filter((s) => sellerMatches(s, { type: 'business' }))).toEqual([shop]);
    expect([dana, shop, unset].filter((s) => sellerMatches(s, { type: 'individual', payout: 'NONE' }))).toEqual([unset]);
    expect([dana, shop, unset].filter((s) => sellerMatches(s, {}))).toEqual([dana, shop, unset]);
  });

  it('sorts by a column either way, a missing value as empty', () => {
    expect(sortSellers([shop, unset, dana]).map((s) => s.displayName)).toEqual(['Dana Reyes', 'Little Mountain', 'Sam Ortiz']);
    expect(sortSellers([shop, unset, dana], 'payoutMethod', 'desc').map((s) => s.displayName)).toEqual(['Dana Reyes', 'Little Mountain', 'Sam Ortiz']);
    expect(sortSellers([dana, shop], 'email').map((s) => s.displayName)).toEqual(['Little Mountain', 'Dana Reyes']);
  });
});
