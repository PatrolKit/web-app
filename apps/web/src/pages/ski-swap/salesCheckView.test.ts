import { describe, expect, it } from 'vitest';
import { acceptedText, byCategory, groupsOf, missedFeesText, paidPriceButtons, payOnceChoices, paidPriceDoneText, squarePriceOf, patrolKitSide, squareSide, suggestedLines, withDecided } from './salesCheckView';
import type { SalesCheckIssue } from '../../lib/api.types';

const issue = (over: Partial<SalesCheckIssue>): SalesCheckIssue => ({
  key: 'o:u', kind: 'other_item', orderId: 'o', lineUid: 'u', soldAt: '2026-10-09T18:00:00Z', quantity: 1, refundedQuantity: 0,
  collectedCents: 4000, unitPriceCents: 4000, rungUpAs: null, suggestion: null, ticket: null, categoryIds: [], links: { sale: null, item: null }, receipt: null,
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

describe('a sale paid at another price', () => {
  const paid = { itemId: 'it', sku: '59420', name: 'Poles', sellerName: 'Kevin', sellerId: 's1', priceCents: 600, rungCents: 700, paidCents: 700 };
  const typed = issue({ key: 'o1:#price:u', kind: 'price_paid', receipt: 'Gq00', links: { sale: 'https://sq/sale', item: null }, collectedCents: 700, unitPriceCents: 700, paid });

  it('is its own group, sorted by its ticket', () => {
    expect(groupsOf([typed]).map((g) => g.title)).toEqual(['Sold for a different price']);
  });

  it('shows what was paid against PatrolKit’s price, and that the seller is paid PatrolKit’s', () => {
    expect(squareSide(typed).fields.map((f) => [f.label, f.value, f.warn ?? false])).toEqual([['Receipt', '#Gq00', false], ['Paid', '$7.00', true]]);
    expect(patrolKitSide(typed).fields.map((f) => [f.label, f.value, f.tag ?? null])).toEqual([
      ['SKU', '59420', null], ['Name', 'Poles', null], ['Seller', 'Kevin', null], ['Price', '$6.00', 'the seller is paid this'],
    ]);
  });

  it('says when it was a discount', () => {
    const off = { ...typed, paid: { ...paid, priceCents: 4000, rungCents: 4000, paidCents: 3600 } };
    expect(squareSide(off).fields.map((f) => [f.label, f.value, f.tag ?? null])).toEqual([['Receipt', '#Gq00', null], ['Rung up at', '$40.00', null], ['Paid', '$36.00', 'after a discount']]);
  });

  it('names each button with its price, and says what was done', () => {
    expect(paidPriceButtons(paid)).toEqual({ keep: 'Keep PatrolKit price ($6.00)', use: 'Set PatrolKit price to $7.00' });
    expect(paidPriceDoneText(paid, 'keep')).toBe('Kept PatrolKit’s price for 59420: $6.00, though it sold for $7.00.');
    expect(paidPriceDoneText(paid, 'use')).toBe('Set 59420’s PatrolKit price to $7.00, what it sold for; Square’s left as it sold.');
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
      title: 'To refund', fields: [{ label: 'Refund', value: '$7.67 (the Shop Fee)', warn: true }], links: [],
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

describe('Square’s price for an unpriced item', () => {
  it('is what one unit sold for', () => {
    expect(squarePriceOf(issue({ unitPriceCents: 4000, collectedCents: 4000 }))).toBe(4000);
    expect(squarePriceOf(issue({ unitPriceCents: null, collectedCents: 8000, quantity: 2 }))).toBe(4000);
    expect(squarePriceOf(issue({ unitPriceCents: 0, collectedCents: 0 }))).toBeNull();
  });
});

describe('sorting', () => {
  it('puts each group in SKU order, numbers as numbers, and those with none last by time', () => {
    const copy = (sku: string, key: string) => issue({ key, kind: 'other_copy', suggestion: { itemId: key, sku, name: 'x', priceCents: null, sellerName: null, sellerId: null } });
    const fee = (key: string, soldAt: string) => issue({ key, kind: 'other_copy', soldAt });
    const [g] = groupsOf([copy('73338', 'a'), fee('late', '2026-10-09T20:00:00Z'), copy('9001', 'b'), fee('early', '2026-10-09T15:00:00Z'), copy('73308', 'c')]);
    expect(g.issues.map((i) => i.key)).toEqual(['b', 'c', 'a', 'early', 'late']);
  });
});

describe('a ticket scanned twice in one sale', () => {
  const twice = issue({
    kind: 'scanned_twice', collectedCents: 1950, links: { sale: 'https://sq/sale', item: null },
    suggestion: { itemId: 'it', sku: '73475', name: 'Poles', priceCents: 2200, sellerName: 'Karen Beckwith', sellerId: 's-1' },
  });

  it('shows the item as already sold in this sale, with no refund link', () => {
    const side = patrolKitSide(twice);
    expect(side.title).toBe('Already sold in this sale');
    expect(side.links).toEqual([{ label: 'Item', to: '/dashboard/ski-swap/items?q=73475' }]);
    expect(groupsOf([twice])[0].title).toBe('Scanned twice in one sale');
  });

  it('is never offered to Accept all', () => {
    expect(suggestedLines([twice])).toEqual([]);
  });
});

describe('the receipt number', () => {
  it('is on each sale’s Square side, to look it up on the POS, then "View in Square" in place of the Sale link', () => {
    const twice = issue({ kind: 'scanned_twice', receipt: 'Gq00', links: { sale: 'https://sq/Gq00', item: null }, rungUpAs: { name: 'Swap Item 73475', sku: '73475', variationId: 'v', itemId: 'i', category: '2025', archived: true } });
    expect(squareSide(twice).fields.find((f) => f.label === 'Receipt')).toEqual({ label: 'Receipt', value: '#Gq00', mono: true, link: { label: 'View in Square', href: 'https://sq/Gq00' } });
    expect(squareSide(twice).links).toEqual([]);
    const fee = issue({ kind: 'double_fee', receipt: 'Ab12', fee: { shopFeeName: 'Shop Fee', shopFeeCents: 767, surchargeCents: 787, cardCents: 31054, cashCents: 0, refundCents: 767 } });
    expect(squareSide(fee).fields[0]).toEqual({ label: 'Receipt', value: '#Ab12', mono: true });
    expect(squareSide(issue({})).fields.some((f) => f.label === 'Receipt')).toBe(false);
  });
});

describe('a ticket rung up more times than it has units', () => {
  const repeat = (kind: 'scanned_twice' | 'oversold', sales: { orderId: string; receipt: string; soldAt: string; quantity: number; collectedCents: number }[]) => issue({
    kind, key: `${kind}:x`,
    oversold: {
      itemId: 'it', sku: '73297', name: 'Item #73297', sellerName: 'Karen Beckwith', priceCents: null, units: 2, quantity: 1,
      orders: [...new Set(sales.map((s) => s.orderId))], sales: sales.map((s, n) => ({ lineUid: `l${n}`, unitPriceCents: null, ...s, link: `https://sq/${s.orderId}` })),
    },
  });

  it('lists each line of the one sale, and its receipt to view in Square', () => {
    const side = squareSide(repeat('scanned_twice', [
      { orderId: 'WE', receipt: 'WErn', soldAt: '2026-10-09T19:19:00Z', quantity: 1, collectedCents: 1000 },
      { orderId: 'WE', receipt: 'WErn', soldAt: '2026-10-09T19:19:00Z', quantity: 1, collectedCents: 2000 },
    ]));
    expect(side.title).toBe('Rung up in one sale');
    expect(side.fields.map((f) => [f.label, f.value]).filter(([l]) => l !== 'When')).toEqual([['Receipt', '#WErn'], ['Line 1', '$10.00'], ['Line 2', '$20.00']]);
    expect(side.fields[0].link).toEqual({ label: 'View in Square', href: 'https://sq/WE' });
    expect(side.links).toEqual([]);
  });

  it('lists each sale across sales by receipt, each to view in Square', () => {
    const side = squareSide(repeat('oversold', [
      { orderId: 'l5', receipt: '8pWs', soldAt: '2026-10-09T18:17:00Z', quantity: 1, collectedCents: 8900 },
      { orderId: '3A', receipt: 'mYLC', soldAt: '2026-10-10T19:03:00Z', quantity: 1, collectedCents: 8900 },
    ]));
    expect(side.title).toBe('Sold in different sales');
    expect(side.fields.map((f) => f.label)).toEqual(['#8pWs', '#mYLC']);
    expect(side.fields.map((f) => f.link?.href)).toEqual(['https://sq/l5', 'https://sq/3A']);
    expect(side.links).toEqual([]);
  });

  it('shows the item with its seller, price and quantity checked in', () => {
    const side = patrolKitSide(repeat('scanned_twice', [{ orderId: 'WE', receipt: 'WErn', soldAt: '2026-10-09T19:19:00Z', quantity: 2, collectedCents: 4000 }]));
    expect(side.fields.map((f) => [f.label, f.value])).toEqual([['SKU', '73297'], ['Name', 'Item #73297'], ['Seller', 'Karen Beckwith'], ['Price', 'unpriced'], ['Checked in', '1']]);
  });
});

describe('Pay once: which line the seller is paid for', () => {
  type Sale = NonNullable<SalesCheckIssue['oversold']>['sales'][number];
  const sale = (lineUid: string, collectedCents: number, over: Partial<Sale> = {}): Sale => ({
    orderId: 'WE', lineUid, receipt: 'WErn', soldAt: '2026-10-09T19:19:00Z', quantity: 1, collectedCents, unitPriceCents: collectedCents, link: null, ...over,
  });
  const twice = (priceCents: number | null, sales: Sale[]) => ({
    itemId: 'it', sku: '73297', name: 'Item #73297', sellerName: 'Karen Beckwith', priceCents, units: sales.length, quantity: 1, orders: ['WE'], sales,
  });

  it('starts on the line rung up at PatrolKit’s price, among any number', () => {
    const { choices, picked } = payOnceChoices(twice(2000, [sale('a', 1000), sale('b', 700), sale('c', 2000), sale('d', 2000)]));
    expect(choices.map((c) => [c.label, c.matches])).toEqual([
      ['Line 1: $10.00', false], ['Line 2: $7.00', false], ['Line 3: $20.00', true], ['Line 4: $20.00', true],
    ]);
    expect(picked).toBe('c');
  });

  it('matches a discounted line by what it was rung up at, not what it took', () => {
    expect(payOnceChoices(twice(2000, [sale('a', 1000), sale('b', 1800, { unitPriceCents: 2000 })])).picked).toBe('b');
  });

  it('starts on the only line, as a quantity of 2 (73190)', () => {
    const { choices, picked } = payOnceChoices(twice(2000, [sale('c', 4000, { quantity: 2, unitPriceCents: 2000 })]));
    expect([choices[0].label, picked]).toEqual(['Line 1: $40.00 (×2)', 'c']);
  });

  it('leaves the pick to a person when none matches, or the ticket is unpriced', () => {
    expect(payOnceChoices(twice(2500, [sale('a', 1000), sale('b', 2000)])).picked).toBeNull();
    expect(payOnceChoices(twice(null, [sale('a', 1000), sale('b', 2000)])).picked).toBeNull();
  });
});
