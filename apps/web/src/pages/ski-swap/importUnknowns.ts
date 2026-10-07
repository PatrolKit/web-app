import type { ImportUnknown, TicketImportRow } from '../../lib/api.types';

/**
 * A refused upload's unknowns, grouped the way they get fixed (Plan 42 D6):
 * one entry per category, detail and value, with the lines it's on. Adding
 * "Alpina" once fixes all 31 rows that say it.
 */
export interface UnknownGroup {
  key: string;
  /** "Ski boots · Manufacturer · Alpina", or "Category · Ski/Bdg". */
  label: string;
  /** Why it didn't match, when it isn't simply "not in our list". */
  note?: string;
  lines: number[];
}

function noteOf(u: ImportUnknown): string | undefined {
  switch (u.reason) {
    case 'not_a_number': return 'not a number';
    case 'out_of_range': return 'outside the range we take';
    case 'off_step': return u.step ? `not in steps of ${u.step}` : 'between the steps we take';
    case 'needs_parent': return u.under ? `not listed under ${u.under}` : `needs a ${u.parent ?? 'parent'} on the row`;
    case 'unknown_value': return u.under ? `under ${u.under}` : undefined;
    default: return undefined;
  }
}

export function groupUnknowns(rows: TicketImportRow[]): UnknownGroup[] {
  const groups = new Map<string, UnknownGroup>();
  for (const row of rows) {
    for (const u of row.unknown ?? []) {
      const label = u.reason === 'unknown_category'
        ? `Category · ${u.value}`
        : [u.category, u.column, u.value].filter(Boolean).join(' · ');
      const note = noteOf(u);
      const key = `${label.toLowerCase()}|${note ?? ''}`;
      const group = groups.get(key) ?? { key, label, ...(note ? { note } : {}), lines: [] };
      group.lines.push(row.line);
      groups.set(key, group);
    }
  }
  // Unknown categories first (they hide a row's details), then the busiest.
  return [...groups.values()].sort((a, b) =>
    Number(b.label.startsWith('Category · ')) - Number(a.label.startsWith('Category · '))
    || b.lines.length - a.lines.length
    || a.label.localeCompare(b.label));
}

/** Every unknown cell in the file: what an import anyway leaves out. */
export function unknownCount(rows: TicketImportRow[]): number {
  return rows.reduce((n, r) => n + (r.unknown?.length ?? 0), 0);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The list as plain text, to hand to whoever adds the values. */
export function unknownsText(groups: UnknownGroup[]): string {
  return groups.map((g) => `${g.label}${g.note ? ` (${g.note})` : ''}: ${plural(g.lines.length, 'row')}`).join('\n');
}

/** "1,128 tickets described, 1,071 with a category; 37 values won't be saved". */
export function importAnywaySummary(rows: TicketImportRow[]): string {
  const tickets = rows.filter((r) => r.itemId).length;
  const generated = rows.filter((r) => r.generated).length;
  const withCategory = rows.filter((r) => r.categoryId).length;
  const parts = [
    tickets ? `${plural(tickets, 'ticket')} described` : null,
    generated ? `${plural(generated, 'new item')}` : null,
  ].filter(Boolean).join(' and ');
  const skipped = unknownCount(rows);
  return `${parts || 'Nothing'}${withCategory ? `, ${withCategory.toLocaleString('en-US')} with a category` : ''}; ${plural(skipped, 'value')} won’t be saved`;
}
