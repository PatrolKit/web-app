import { describe, expect, it } from 'vitest';
import { groupsOf, sentence, suggestedLines } from './salesCheckView';
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

describe('what each issue says', () => {
  it('names the copy, the seller and the amount', () => {
    expect(sentence(issue({
      kind: 'other_copy',
      rungUpAs: { name: 'Swap Item 73338', sku: '73338', variationId: 'v', itemId: 'i', category: '2025', archived: true },
      suggestion: { itemId: 'it', sku: '73338', name: 'Item #73338', priceCents: null, sellerName: 'Karen Beckwith' },
    }))).toBe('Ticket 73338 was rung up on “Swap Item 73338”, an archived item in “2025”, for $40.00. It isn’t on Karen Beckwith’s item.');
    expect(sentence(issue({ kind: 'unknown_ticket', ticket: '59443', collectedCents: 1000, rungUpAs: { name: 'Swap Item 59443', sku: '59443', variationId: 'v', itemId: 'i', category: '2025', archived: true } })))
      .toBe('Ticket 59443 isn’t in PatrolKit. It sold as “Swap Item 59443” for $10.00.');
  });
});

describe('Credit all suggested', () => {
  it('lists exactly the lines with a suggestion, nothing else', () => {
    const lines = suggestedLines([
      issue({ kind: 'other_copy', orderId: 'a', lineUid: '1', suggestion: { itemId: 'it-1', sku: '73338', name: 'x', priceCents: null, sellerName: null } }),
      issue({ kind: 'register_item', orderId: 'b', lineUid: '2', suggestion: { itemId: 'it-2', sku: '86882', name: 'y', priceCents: 5400, sellerName: null } }),
      issue({ kind: 'unknown_ticket', orderId: 'c', lineUid: '3', ticket: '59443' }),
    ]);
    expect(lines.map((l) => [l.orderId, l.lineUid, l.itemId])).toEqual([['a', '1', 'it-1'], ['b', '2', 'it-2']]);
  });
});
