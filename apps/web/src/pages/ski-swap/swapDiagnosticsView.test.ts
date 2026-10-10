import { describe, expect, it } from 'vitest';
import type { DiagnosticIssueResponse, DiagnosticRunResponse } from '../../lib/api.types';
import { centsOf, decidedText, groupChoiceLabel, groupsOf, heldText, isHeld, priceDecidedText, priceSides, rowChoices, shown } from './swapDiagnosticsView';

const issue = (over: Partial<DiagnosticIssueResponse>): DiagnosticIssueResponse => ({
  id: 'i', sku: 'SP-0001', kind: 'only_ours', field: null, ours: null, square: null, state: 'open',
  choice: null, decidedByName: null, decidedAt: null, error: null, ...over,
});
const sq = (priceCents: number | null) => ({ itemId: 's', variationId: 'v', name: 'Skis', notes: null, priceCents, version: '1', updatedAt: null });
const run = (issues: DiagnosticIssueResponse[]): DiagnosticRunResponse => ({
  id: 'r', status: 'done', startedAt: '', finishedAt: null, startedByName: null, done: 0, ourCount: 0, squareCount: 0, error: null, issues,
});

describe('the diagnostics popover (Plan 41)', () => {
  it('groups by kind, and Differs by field, most urgent first, counting open rows', () => {
    const groups = groupsOf(run([
      issue({ id: '1', kind: 'only_square' }),
      issue({ id: '2', kind: 'differs', field: 'price', square: sq(100) }),
      issue({ id: '3', kind: 'differs', field: 'name', square: sq(100), state: 'applied' }),
      issue({ id: '4', kind: 'only_ours' }),
    ]));
    expect(groups.map((g) => [g.title, g.open])).toEqual([
      ['In PatrolKit, not in Square', 1], ['Price differs', 1], ['Name differs', 0], ['In Square, not in PatrolKit', 1],
    ]);
  });

  it('offers each kind its own choices, and Mark resolved everywhere', () => {
    expect(rowChoices(issue({ kind: 'only_ours' }))).toEqual(['copy_to_square', 'resolve']);
    expect(rowChoices(issue({ kind: 'only_square' }))).toEqual(['copy_to_patrolkit', 'resolve']);
    expect(rowChoices(issue({ kind: 'not_linked' }))).toEqual(['link', 'resolve']);
    expect(rowChoices(issue({ kind: 'twice' }))).toEqual(['resolve']);
  });

  it('offers Use Square’s no price only to a ticket', () => {
    expect(rowChoices(issue({ kind: 'differs', field: 'price', square: sq(null) }))).toEqual(['use_ours']);
    expect(rowChoices(issue({ sku: '67169', kind: 'differs', field: 'price', square: sq(null) })))
      .toEqual(['use_square', 'use_ours']);
  });

  it('has no group form of Keep this copy', () => {
    expect(groupsOf(run([issue({ kind: 'twice' })]))[0].groupChoices).toEqual(['resolve']);
  });

  it('says what a group button does, with the count', () => {
    expect(groupChoiceLabel('copy_to_square', 300)).toBe('Copy all 300 to Square');
    expect(groupChoiceLabel('resolve', 1200)).toBe('Mark all 1,200 resolved');
  });

  it('shows each side’s value', () => {
    expect(shown('price', { name: '', notes: null, priceCents: null })).toBe('No price');
    expect(shown('price', { name: '', notes: null, priceCents: 4500 })).toBe('$45.00');
    expect(shown('notes', { name: '', notes: null, priceCents: 0 })).toBe('No notes');
  });

  it('says how Mark resolved ended', () => {
    expect(decidedText(issue({ state: 'fixed', choice: 'resolve', decidedByName: 'Dana' }))).toBe('Resolved, fixed by Dana');
    expect(decidedText(issue({ state: 'left', choice: 'resolve' }))).toBe('Resolved, left as is');
    expect(decidedText(issue({ state: 'applied', choice: 'link' }))).toBe('Link to it');
  });
});

describe('issues an open sale holds back (Plan 48)', () => {
  it('counts held rows apart, and only open ones', () => {
    const [g] = groupsOf(run([
      issue({ id: '1', kind: 'elsewhere', sku: '73308', heldBySales: 2 }),
      issue({ id: '2', kind: 'elsewhere', sku: '73001', heldBySales: 0 }),
      issue({ id: '3', kind: 'elsewhere', sku: '73002', heldBySales: 1, state: 'applied' }),
    ]));
    expect([g.open, g.held]).toEqual([2, 1]);
    expect(isHeld(issue({ heldBySales: 1, state: 'failed' }))).toBe(true);
  });

  it('says what holds it, and where to go', () => {
    expect(heldText(issue({ sku: '73308', heldBySales: 2 }))).toMatch(/^Ticket 73308 has 2 open sales in Sales check\. Settle them there first/);
    expect(heldText(issue({ sku: '73308', heldBySales: 1 }))).toMatch(/^Ticket 73308 has an open sale in Sales check\. Settle it there first/);
  });
});

describe('Price differs as a card', () => {
  const ours = { itemId: 'o', name: 'Item #73308', notes: null, priceCents: 5000, squareItemId: 's', squareVariationId: 'v', sellerName: 'Karen Beckwith' };
  const price = issue({ kind: 'differs', field: 'price', sku: '73308', ours, square: sq(4500), squareUrl: 'https://sq/item' });

  it('offers no Mark resolved, alone or for the group, and no new price for the group', () => {
    expect(rowChoices(price)).toEqual(['use_square', 'use_ours']);
    expect(groupsOf(run([price]))[0].groupChoices).toEqual(['use_square', 'use_ours']);
    expect(rowChoices(issue({ kind: 'differs', field: 'name', square: sq(1) }))).toEqual(['use_square', 'use_ours', 'resolve']);
  });

  it('shows each side with its price flagged, and its links', () => {
    const { square, ours: our } = priceSides(price);
    expect(square.fields.map((f) => [f.label, f.value, f.warn ?? false])).toEqual([['SKU', '73308', false], ['Name', 'Skis', false], ['Price', '$45.00', true]]);
    expect(our.fields.map((f) => [f.label, f.value])).toEqual([['SKU', '73308'], ['Name', 'Item #73308'], ['Seller', 'Karen Beckwith'], ['Price', '$50.00']]);
    expect([square.links, our.links]).toEqual([[{ label: 'Item', href: 'https://sq/item' }], [{ label: 'Item', to: '/dashboard/ski-swap/items?q=73308' }]]);
  });

  it('says what the price is now', () => {
    expect(priceDecidedText({ ...price, state: 'applied', choice: 'use_square', decidedByName: 'Dana' })).toBe('Used Square’s price: $45.00 in both by Dana');
    expect(priceDecidedText({ ...price, state: 'applied', choice: 'set_price' }, 4000)).toBe('Set a different price: $40.00 in both');
  });

  it('reads a typed price', () => {
    expect([centsOf('40'), centsOf('$40.5'), centsOf(' 40.50 '), centsOf('0'), centsOf('4o'), centsOf('40.555')]).toEqual([4000, 4050, 4050, null, null, null]);
  });
});

