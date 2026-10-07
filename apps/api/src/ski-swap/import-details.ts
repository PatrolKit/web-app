import type { ResolvedAttribute, ResolvedCategory, ResolvedTaxonomy } from '../contracts/taxonomy.contracts';
import type { ItemAttributeInput } from './taxonomy/taxonomy.service';

/**
 * Categories and item details in an imported file (Plan 42).
 *
 * Pure: the parsed header and cells in, and the tree as `TaxonomyService.resolve`
 * gives it. Nothing is guessed (no aliases) and nothing is minted (no
 * `freeText`): a cell matches a listed value, or it's reported as unknown.
 */

/** The columns the importer has always read, by every name it accepts. */
export const BASE_COLUMNS = {
  sku: ['sku', 'ticket', 'ticket number', 'number', 'tag'],
  name: ['name', 'item', 'title'],
  // Its own column, not a name. Square shows a description to buyers, and a
  // shop writing "177cm, small topsheet scratch" means it as the detail under
  // the title.
  description: ['description', 'details', 'notes'],
  price: ['price', 'amount', 'cost', 'value'],
  category: ['category'],
} as const;

export type UnknownReason = 'unknown_category' | 'unknown_value' | 'needs_parent' | 'out_of_range' | 'off_step' | 'not_a_number';

/** A cell that couldn't be matched, and so isn't stored. */
export interface ImportUnknown {
  /** The detail's label as we spell it, or `category`. */
  column: string;
  /** The cell, as written. */
  value: string;
  reason: UnknownReason;
  /** The row's category, when it had one we know. */
  category?: string;
  /** For a nested detail: what it hangs under ("Manufacturer"), and the row's answer to it if any ("Volkl"). */
  parent?: string;
  under?: string;
  /** For a number between the detail's steps: the step it goes in. */
  step?: number;
}

export interface MatchedRow {
  categoryId?: string;
  /** Only what matched, so an import anyway writes it as it stands. */
  attributes: ItemAttributeInput[];
  unknown: ImportUnknown[];
}

export interface MatchedFile {
  rows: MatchedRow[];
  /** Columns that are neither ours nor any category's detail, as headed in the file. */
  ignoredColumns: string[];
}

/**
 * Spelling, not meaning: case, spacing, accents and apostrophe styles don't
 * count, so "Volkl" finds "Völkl" and "Arc'teryx" finds "Arc’teryx". "Rossi"
 * still doesn't find "Rossignol".
 */
const norm = (s: string) =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’‘`´]/g, "'").trim().toLowerCase().replace(/\s+/g, ' ');
/** "Ski boot" finds "Ski boots": a trailing s doesn't count, either side. */
const singular = (s: string) => (s.endsWith('s') ? s.slice(0, -1) : s);

const BASE = new Set<string>(Object.values(BASE_COLUMNS).flat());

/** Every detail anywhere under these questions: what a header may name. */
function detailLabels(attrs: ResolvedAttribute[], into: Set<string>): Set<string> {
  for (const a of attrs) {
    into.add(norm(a.label));
    for (const v of a.values ?? []) detailLabels(v.attributes, into);
  }
  return into;
}

/** Each detail under a category that hangs under a value, with the question above it. */
function nestedDetails(
  attrs: ResolvedAttribute[],
  parent: ResolvedAttribute | null,
  into: Map<string, { label: string; parent: string }>,
): Map<string, { label: string; parent: string }> {
  for (const a of attrs) {
    if (parent && !into.has(norm(a.label))) into.set(norm(a.label), { label: a.label, parent: parent.label });
    for (const v of a.values ?? []) nestedDetails(v.attributes, a, into);
  }
  return into;
}

/** Whether `n` sits on one of the detail's steps, counted from its minimum, as `resolveAnswers` checks. */
function onStep(n: number, a: ResolvedAttribute): boolean {
  if (!a.step || a.step <= 0) return true;
  const steps = (n - (a.min ?? 0)) / a.step;
  return Math.abs(steps - Math.round(steps)) <= 1e-6;
}

/**
 * A number in the detail's unit, checked as `resolveAnswers` will check it.
 * A cell marked in inches is converted for a detail in cm (shops write pole
 * lengths as 42"), and, being approximate, rounded to the nearest step.
 */
function readNumber(raw: string, a: ResolvedAttribute): { value: number } | { reason: UnknownReason } {
  const m = /-?\d+(?:\.\d+)?/.exec(raw);
  if (!m) return { reason: 'not_a_number' };
  let n = Number(m[0]);
  const inches = /["”]|\bin\b|\binch(es)?\b/i.test(raw.slice(m.index + m[0].length));
  if (inches && a.unit?.toLowerCase() === 'cm') {
    n *= 2.54;
    const base = a.min ?? 0;
    n = a.step && a.step > 0 ? base + Math.round((n - base) / a.step) * a.step : Math.round(n);
  }
  if ((a.min !== undefined && n < a.min) || (a.max !== undefined && n > a.max)) return { reason: 'out_of_range' };
  if (!onStep(n, a)) return { reason: 'off_step' };
  return { value: n };
}

export function matchImportDetails(headers: string[], rows: string[][], taxonomy: ResolvedTaxonomy): MatchedFile {
  const categories = taxonomy.categories;
  const known = new Set<string>();
  for (const c of categories) detailLabels(c.attributes, known);

  // The first column under each name wins; a repeat is ignored like any other stranger.
  const columnOf = new Map<string, number>();
  const ignoredColumns: string[] = [];
  headers.forEach((h, i) => {
    const key = norm(h);
    if (!key) return;
    if (BASE.has(key) && key !== 'category') return;
    if ((key === 'category' || known.has(key)) && !columnOf.has(key)) columnOf.set(key, i);
    else ignoredColumns.push(h.trim());
  });

  const categoryAt = columnOf.get('category');
  const byLabel = new Map<string, ResolvedCategory>();
  for (const c of categories) byLabel.set(singular(norm(c.label)), c);
  const nestedFor = new Map<string, Map<string, { label: string; parent: string }>>();

  const matched = rows.map((cells): MatchedRow => {
    const cell = (i: number | undefined) => (i === undefined ? '' : (cells[i] ?? '').trim());
    const written = cell(categoryAt);
    if (!written) return { attributes: [], unknown: [] };
    const category = byLabel.get(singular(norm(written)));
    if (!category) return { attributes: [], unknown: [{ column: 'category', value: written, reason: 'unknown_category' }] };

    const attributes: ItemAttributeInput[] = [];
    const unknown: ImportUnknown[] = [];
    const reached = new Set<string>();
    const answered = new Map<string, string>();
    const miss = (a: ResolvedAttribute, value: string, reason: UnknownReason, under?: { parent: string; under: string }) =>
      unknown.push({ column: a.label, value, reason, category: category.label, ...(under ?? {}) });

    const answer = (attrs: ResolvedAttribute[], above: { parent: string; under: string } | null) => {
      for (const a of attrs) {
        const key = norm(a.label);
        reached.add(key);
        const raw = cell(columnOf.get(key));
        if (!raw) continue;
        if (a.input === 'number') {
          const read = readNumber(raw, a);
          if ('reason' in read) {
            miss(a, raw, read.reason, above ?? undefined);
            if (read.reason === 'off_step') unknown[unknown.length - 1].step = a.step;
          }
          else attributes.push({ attributeId: a.id, numberValue: read.value });
          continue;
        }
        const value = (a.values ?? []).find((v) => norm(v.label) === norm(raw));
        if (!value) {
          miss(a, raw, 'unknown_value', above ?? undefined);
          continue;
        }
        attributes.push({ attributeId: a.id, valueId: value.id });
        answered.set(key, value.label);
        answer(value.attributes, { parent: a.label, under: value.label });
      }
    };
    answer(category.attributes, null);

    // A nested detail the row never reached: its parent is blank, unknown,
    // or an answer without that detail ("Mantra 84" under Alpina).
    let nested = nestedFor.get(category.id);
    if (!nested) nestedFor.set(category.id, (nested = nestedDetails(category.attributes, null, new Map())));
    for (const [key, { label, parent }] of nested) {
      if (reached.has(key)) continue;
      const raw = cell(columnOf.get(key));
      if (!raw) continue;
      const under = answered.get(norm(parent));
      unknown.push({ column: label, value: raw, reason: 'needs_parent', category: category.label, parent, ...(under ? { under } : {}) });
    }

    return { categoryId: category.id, attributes, unknown };
  });

  return { rows: matched, ignoredColumns };
}
