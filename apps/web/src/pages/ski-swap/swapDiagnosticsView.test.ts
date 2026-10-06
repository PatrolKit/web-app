import { describe, expect, it } from 'vitest';
import type { DiagnosticIssueResponse, DiagnosticRunResponse } from '../../lib/api.types';
import { decidedText, groupChoiceLabel, groupsOf, rowChoices, shown } from './swapDiagnosticsView';

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
    expect(rowChoices(issue({ kind: 'differs', field: 'price', square: sq(null) }))).toEqual(['use_ours', 'resolve']);
    expect(rowChoices(issue({ sku: '67169', kind: 'differs', field: 'price', square: sq(null) })))
      .toEqual(['use_square', 'use_ours', 'resolve']);
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
