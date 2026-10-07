import type { ResolvedAttribute, ResolvedTaxonomy } from '../contracts/taxonomy.contracts';
import { matchImportDetails } from './import-details';

/**
 * The three downloads beside an item upload (Plan 42 D12), built from the
 * patrol's tree when asked for, so they're always current.
 */

const BASE_HEADERS = ['ticket', 'name', 'price', 'description', 'category'];
const LEADING = ['manufacturer', 'model'];

/** A cell as a spreadsheet reads it back: quoted when it holds a comma, a quote or a line break. */
function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const csv = (rows: string[][]) => `${rows.map((r) => r.map(cell).join(',')).join('\n')}\n`;

function walk(attrs: ResolvedAttribute[], visit: (a: ResolvedAttribute, onlyWhen: string[]) => void, onlyWhen: string[] = []) {
  for (const a of attrs) {
    visit(a, onlyWhen);
    for (const v of a.values ?? []) walk(v.attributes, visit, [...onlyWhen, `${a.label} = ${v.label}`]);
  }
}

/**
 * The header row only: ours, then every detail once: Manufacturer and Model,
 * then the most used first. "Used" is how many categories ask it, so Model counts once for Skis however
 * many manufacturers list models; a tie keeps the order the tree asks them.
 */
export function templateCsv(taxonomy: ResolvedTaxonomy): string {
  const counts = new Map<string, { label: string; categories: Set<string>; first: number }>();
  for (const c of taxonomy.categories) {
    walk(c.attributes, (a) => {
      const key = a.label.trim().toLowerCase();
      const seen = counts.get(key) ?? { label: a.label, categories: new Set<string>(), first: counts.size };
      seen.categories.add(c.id);
      counts.set(key, seen);
    });
  }
  // Who made it, then which one: how a shop's list reads, ahead of the count.
  const lead = (label: string) => { const i = LEADING.indexOf(label.toLowerCase()); return i === -1 ? LEADING.length : i; };
  const details = [...counts.values()]
    .sort((x, y) => lead(x.label) - lead(y.label) || y.categories.size - x.categories.size || x.first - y.first)
    .map((d) => d.label);
  return csv([[...BASE_HEADERS, ...details]]);
}

/**
 * Four items as a shop would list them. Fixed here; at download each value
 * is kept only if the tree has it, and an item whose category it lacks is left
 * out, so every value in the example matches.
 */
const SAMPLES: { cells: Record<string, string> }[] = [
  { cells: { ticket: '1001', name: 'Rossignol Experience 170', price: '249', description: 'Tuned this fall, small topsheet scratch', category: 'Skis', Manufacturer: 'Rossignol', Model: 'Experience', Length: '170', 'Bindings included': 'Yes' } },
  { cells: { ticket: '1002', name: 'Salomon S/Pro 26.5', price: '129', category: 'Ski boots', Manufacturer: 'Salomon', Model: 'S/Pro', Mondopoint: '26.5', Gender: 'Mens', Color: 'Black' } },
  { cells: { ticket: '1003', name: 'Patagonia Powder Bowl jacket', price: '95', category: 'Jacket', Manufacturer: 'Patagonia', Size: 'M', Gender: 'Womens', Color: 'Blue' } },
  { cells: { ticket: '1004', name: 'Leki poles 120cm', price: '20', category: 'Poles', Manufacturer: 'Leki', Length: '120' } },
];

export function exampleCsv(taxonomy: ResolvedTaxonomy): string {
  const headers = [...BASE_HEADERS];
  for (const s of SAMPLES) for (const key of Object.keys(s.cells)) if (!headers.includes(key)) headers.push(key);
  const rows = SAMPLES.map((s) => headers.map((h) => s.cells[h] ?? ''));

  const { rows: matched } = matchImportDetails(headers, rows, taxonomy);
  const kept: string[][] = [];
  matched.forEach((m, i) => {
    if (m.unknown.some((u) => u.reason === 'unknown_category')) return;
    const row = [...rows[i]];
    for (const u of m.unknown) {
      const at = headers.findIndex((h) => h.toLowerCase() === u.column.toLowerCase());
      if (at !== -1) row[at] = '';
    }
    kept.push(row);
  });
  return csv([headers, ...kept]);
}

/** One row per detail, with what it hangs under and every value it takes. */
export function detailsCsv(taxonomy: ResolvedTaxonomy): string {
  const rows: string[][] = [['category', 'detail', 'only when', 'kind', 'values']];
  for (const c of taxonomy.categories) {
    walk(c.attributes, (a, onlyWhen) => {
      const range = a.min !== undefined && a.max !== undefined
        ? `${a.min}–${a.max}`
        : a.min !== undefined ? `${a.min} or more` : a.max !== undefined ? `up to ${a.max}` : 'any number';
      const values = a.input === 'number'
        ? [range, a.unit].filter(Boolean).join(' ')
        : (a.values ?? []).map((v) => v.label).join(' | ');
      rows.push([c.label, a.label, onlyWhen.join('; '), a.input === 'number' ? 'number' : 'list', values]);
    });
  }
  return csv(rows);
}

/** The downloads by the name each is asked for, and what each saves as. */
export const IMPORT_GUIDE_FILES = {
  'template.csv': (t: ResolvedTaxonomy) => ({ csv: templateCsv(t), filename: 'items-template.csv' }),
  'example.csv': (t: ResolvedTaxonomy) => ({ csv: exampleCsv(t), filename: 'items-example.csv' }),
  'details.csv': (t: ResolvedTaxonomy) => ({ csv: detailsCsv(t), filename: 'categories-and-details.csv' }),
} as const;
export type ImportGuideFile = keyof typeof IMPORT_GUIDE_FILES;

export function isImportGuideFile(name: string): name is ImportGuideFile {
  return Object.prototype.hasOwnProperty.call(IMPORT_GUIDE_FILES, name);
}
