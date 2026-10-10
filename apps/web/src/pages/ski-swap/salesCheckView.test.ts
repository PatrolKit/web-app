import { describe, expect, it } from 'vitest';
import { acceptedText, byCategory, groupsOf, missedFeesText, patrolKitSide, squareSide, suggestedLines, withDecided } from './salesCheckView';
import type { SalesCheckIssue } from '../../lib/api.types';

const issue = (over: Partial<SalesCheckIssue>): SalesCheckIssue => ({
  key: 'o:u', kind: 'other_item', orderId: 'o', lineUid: 'u', soldAt: '2026-10-09T18:00:00Z', quantity: 1, refundedQuantity: 0,
  collectedCents: 4000, unitPriceCents: 4000, rungUpAs: null, suggestion: null, ticket: null, categoryIds: [], links: { sale: null, item: null },
  ...over,
});

describe('Sales check groups', () => {
  it('puts sales to credit first, and adds up each group', () => {
    const groups = groupsOf([
      issue({ kind: 'other_item', collectedCents: 2000 }),
      issue({ kind: 'other_copy', collectedCents: 4000 }),
      issue({ kind: 'other_copy', collectedCents: 1000 }),
      issue({ kind: 'unknown_ticket' }),
    ]);
    expect(groups.map((g) => [g.kind, g.issues.length, g.cents])).toEqual([['other_copy', 2, 5000], ['unknown_ticket', 1, 4000], ['other_item', 1, 2000]]);
  });
});

describe('the two sides of a card', () => {
  const copy = issue({
    kind: 'other_copy', collectedCents: 500, unitPriceCents: 500, links: { sale: 'https://sq/sale', item: 'https://sq/item' },
    rungUpAs: { name: 'Swap Item 73308', sku: '73308', variationId: 'v', itemId: 'i', category: '2025', archived: true },
    suggestion: { itemId: 'it', sku: '73308', name: 'Item #73308', priceCents: 500, sellerName: 'Karen Beckwith', sellerId: 's-1' },
  });

  it('shows the sale as Square has it, with its links', () => {
    const side = squareSide(copy);
    expect(side.fields.map((f) => [f.label, f.value, f.tag])).toEqual([['SKU', '73308', undefined], ['Name', 'Swap Item 73308', 'archived · 2025'], ['Sold for', '$5.00', undefined]]);
    expect(side.links).toEqual([{ label: 'Sale', href: 'https://sq/sale' }, { label: 'Item', href: 'https://sq/item' }]);
  });

  it('shows the suggested item, its seller, and links into PatrolKit', () => {
    const side = patrolKitSide(copy);
    expect(side.title).toBe('Suggested PatrolKit item');
    expect(side.fields.map((f) => [f.label, f.value, f.warn ?? false])).toEqual([['SKU', '73308', false], ['Name', 'Item #73308', false], ['Seller', 'Karen Beckwith', false], ['Price', '$5.00', false]]);
    expect(side.links).toEqual([{ label: 'Item', to: '/dashboard/ski-swap/items?q=73308' }, { label: 'Seller', to: '/dashboard/ski-swap/sellers?edit=s-1' }]);
  });

  it('flags a seller price that differs from what Square charged', () => {
    const side = patrolKitSide({ ...copy, unitPriceCents: 400 });
    expect(side.fields.find((f) => f.label === 'Price')?.warn).toBe(true);
  });

  it('says why there is no suggestion', () => {
    expect(patrolKitSide(issue({ kind: 'unknown_ticket', ticket: '59443' })).empty).toBe('No ticket 59443 in this swap.');
    expect(patrolKitSide(issue({ kind: 'other_item' })).empty).toBe('Not a swap item.');
    expect(squareSide(issue({ kind: 'custom_amount' })).fields.find((f) => f.label === 'Name')?.value).toBe('Custom amount');
  });
});

describe('other items by category', () => {
  it('folds sales into one row per category, the biggest first', () => {
    const swag = (name: string, cents: number) => issue({ collectedCents: cents, categoryIds: ['cat-swag'], rungUpAs: { name, sku: 'x', variationId: 'v', itemId: 'i', category: 'Swag', archived: false } });
    const rows = byCategory([
      issue({ collectedCents: 700, categoryIds: ['cat-cpr'], rungUpAs: { name: 'CPR Fees', sku: '', variationId: 'v', itemId: 'i', category: 'CPR', archived: false } }),
      swag('TShirt', 2500), swag('TShirt', 2500), swag('Socks', 1500),
    ]);
    expect(rows.map((r) => [r.name, r.categoryId, r.names, r.issues.length, r.cents])).toEqual([
      ['Swag', 'cat-swag', ['TShirt', 'Socks'], 3, 6500],
      ['CPR', 'cat-cpr', ['CPR Fees'], 1, 700],
    ]);
  });
});

describe('Accept all suggestions', () => {
  it('lists exactly the lines with a suggestion, nothing else', () => {
    const lines = suggestedLines([
      issue({ kind: 'other_copy', orderId: 'a', lineUid: '1', suggestion: { itemId: 'it-1', sku: '73338', name: 'x', priceCents: null, sellerName: null, sellerId: null } }),
      issue({ kind: 'register_item', orderId: 'b', lineUid: '2', suggestion: { itemId: 'it-2', sku: '86882', name: 'y', priceCents: 5400, sellerName: null, sellerId: null } }),
      issue({ kind: 'unknown_ticket', orderId: 'c', lineUid: '3', ticket: '59443' }),
    ]);
    expect(lines.map((l) => [l.orderId, l.lineUid, l.itemId])).toEqual([['a', '1', 'it-1'], ['b', '2', 'it-2']]);
  });
});

describe('sales decided on the page', () => {
  const a = issue({ key: 'a', kind: 'other_copy', collectedCents: 1000 });
  const b = issue({ key: 'b', kind: 'other_copy', collectedCents: 2000 });
  const c = issue({ key: 'c', kind: 'other_copy', collectedCents: 3000 });

  it('keeps a decided sale in its place after Square stops listing it', () => {
    const seen = new Map<string, number>();
    expect(withDecided([a, b, c], new Map(), seen).map((i) => i.key)).toEqual(['a', 'b', 'c']);
    expect(withDecided([a, c], new Map([['b', b]]), seen).map((i) => i.key)).toEqual(['a', 'b', 'c']);
  });

  it('counts it out of its group at once, before Square is read again', () => {
    const [g] = groupsOf([a, b, c], new Set(['b']));
    expect([g.issues.length, g.open, g.cents]).toEqual([3, 2, 4000]);
  });

  it('says where the sale went', () => {
    expect(acceptedText(a, { sku: '73308', name: 'Item #73308', sellerName: 'Karen Beckwith' }, true))
      .toBe('$10.00 sale put on 73308 Item #73308 · Karen Beckwith · marked sold in Square');
  });
});

describe('the fee check', () => {
  const both = issue({
    key: 'f1:#fee', kind: 'double_fee', orderId: 'f1', lineUid: '#fee', collectedCents: 767, links: { sale: 'https://sq/sale', item: null },
    fee: { shopFeeName: 'Shop Fee', shopFeeCents: 767, surchargeCents: 787, cardCents: 31054, cashCents: 0, refundCents: 767 },
  });

  it('shows the sale’s fees, and the Shop Fee to refund', () => {
    expect(squareSide(both).fields.map((f) => [f.label, f.value])).toEqual([['Paid', '$310.54 by card'], ['Shop Fee', '$7.67'], ['Surcharge', '$7.87']]);
    expect(patrolKitSide(both)).toEqual({
      title: 'To refund', fields: [{ label: 'Refund', value: '$7.67 (the Shop Fee)', warn: true }], links: [{ label: 'Refund in Square', href: 'https://sq/sale' }],
    });
  });

  it('groups fees after the sales to credit, and leaves them out of Accept all', () => {
    const groups = groupsOf([issue({ kind: 'other_copy', suggestion: { itemId: 'i', sku: '1', name: 'x', priceCents: null, sellerName: null, sellerId: null } }), both]);
    expect(groups.map((g) => [g.kind, g.title])).toEqual([['other_copy', 'Sold on another copy of a ticket'], ['double_fee', 'Charged both fees']]);
    expect(suggestedLines([both])).toEqual([]);
  });

  it('counts card sales charged no fee', () => {
    expect(missedFeesText({ orders: 97, cardCents: 1915250, feeCents: 49797, percentage: '2.6' })).toBe('97 card sales were charged no fee (about $497.97 at 2.6%). Counted here, not flagged.');
    expect([missedFeesText({ orders: 0, cardCents: 0, feeCents: null, percentage: null }), missedFeesText(null)]).toEqual([null, null]);
  });
});

