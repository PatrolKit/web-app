import { describe, expect, it } from 'vitest';
import type { TicketImportRow } from '../../lib/api.types';
import { groupUnknowns, importAnywaySummary, unknownCount, unknownsText } from './importUnknowns';

const row = (line: number, unknown: TicketImportRow['unknown'] = [], over: Partial<TicketImportRow> = {}): TicketImportRow =>
  ({ line, sku: String(line), outcome: 'ok', itemId: `t${line}`, unknown, ...over });

describe('a refused upload’s unknowns (Plan 42)', () => {
  const alpina = { column: 'Manufacturer', value: 'Alpina', reason: 'unknown_value' as const, category: 'Ski boots' };
  const rows = [
    row(2, [alpina], { categoryId: 'boots' }),
    row(3, [alpina], { categoryId: 'boots' }),
    row(4, [{ column: 'category', value: 'Ski/Bdg', reason: 'unknown_category' }]),
    row(5, [{ column: 'Model', value: 'Mantra 84', reason: 'needs_parent', category: 'Skis', parent: 'Manufacturer', under: 'Alpina' }], { categoryId: 'skis' }),
    row(6, [], { categoryId: 'skis' }),
  ];

  it('groups by category, detail and value, unknown categories first, then the busiest', () => {
    expect(groupUnknowns(rows).map((g) => [g.label, g.note, g.lines])).toEqual([
      ['Category · Ski/Bdg', undefined, [4]],
      ['Ski boots · Manufacturer · Alpina', undefined, [2, 3]],
      ['Skis · Model · Mantra 84', 'not listed under Alpina', [5]],
    ]);
  });

  it('counts each value in any case as one group', () => {
    const groups = groupUnknowns([row(2, [alpina]), row(3, [{ ...alpina, value: 'ALPINA' }])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].lines).toEqual([2, 3]);
  });

  it('says what an import anyway would write', () => {
    expect(unknownCount(rows)).toBe(4);
    expect(importAnywaySummary(rows)).toBe('5 tickets described, 4 with a category; 4 values won’t be saved');
  });

  it('copies as plain text', () => {
    expect(unknownsText(groupUnknowns(rows))).toBe([
      'Category · Ski/Bdg: 1 row',
      'Ski boots · Manufacturer · Alpina: 2 rows',
      'Skis · Model · Mantra 84 (not listed under Alpina): 1 row',
    ].join('\n'));
  });
});
