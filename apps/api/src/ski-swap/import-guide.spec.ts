import { readFileSync } from 'fs';
import { join } from 'path';
import type { ResolvedAttribute, ResolvedTaxonomy, ResolvedValue } from '../contracts/taxonomy.contracts';
import type { AttributeSpec, CategorySpec, ValueSpec } from '../../prisma/seed-taxonomy';
import { matchImportDetails } from './import-details';
import { detailsCsv, exampleCsv, templateCsv } from './import-guide';

/** The committed shared tree, shaped as `TaxonomyService.resolve` returns it. */
function committedTree(): ResolvedTaxonomy {
  const specs = JSON.parse(readFileSync(join(__dirname, '../../prisma/taxonomy.json'), 'utf8')) as CategorySpec[];
  const attribute = (a: AttributeSpec, path: string): ResolvedAttribute => ({
    id: `${path}/${a.label}`, label: a.label, scope: 'global', displayOrder: 0, nameSlot: a.nameSlot ?? null,
    input: a.input === 'NUMBER' ? 'number' : 'select',
    ...(a.unit ? { unit: a.unit } : {}), ...(a.min !== undefined ? { min: a.min } : {}), ...(a.max !== undefined ? { max: a.max } : {}),
    values: (a.values ?? []).filter((v) => typeof v === 'string' || !v.retired).map((v) => value(v, `${path}/${a.label}`)),
  });
  const value = (v: ValueSpec, path: string): ResolvedValue => {
    const label = typeof v === 'string' ? v : v.label;
    const attrs = typeof v === 'string' ? [] : (v.attributes ?? []).filter((a) => !a.retired);
    return { id: `${path}=${label}`, label, scope: 'global', displayOrder: 0, attributes: attrs.map((a) => attribute(a, `${path}=${label}`)) };
  };
  return {
    version: 1,
    categories: specs.filter((c) => !c.retired).map((c, i) => ({
      id: c.label, label: c.label, scope: 'global', displayOrder: i,
      attributes: c.attributes.filter((a) => !a.retired).map((a) => attribute(a, c.label)),
    })),
  };
}

const lines = (text: string) => text.trimEnd().split('\n');
const tree = committedTree();

describe('the downloads beside an item upload (Plan 42)', () => {
  it('template: our columns, then each detail once: who made it, which one, then the most used', () => {
    const header = lines(templateCsv(tree));
    expect(header).toHaveLength(1);
    const columns = header[0].split(',');
    expect(columns.slice(0, 9)).toEqual(['ticket', 'name', 'price', 'description', 'category', 'Manufacturer', 'Model', 'Condition', 'Color']);
    expect(new Set(columns.map((c) => c.toLowerCase())).size).toBe(columns.length);
    expect(columns).toContain('Mondopoint');
  });

  it('example: every value matches the committed tree', () => {
    const [header, ...rows] = lines(exampleCsv(tree));
    expect(rows).toHaveLength(4);
    const parse = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.slice(0, -1).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    const matched = matchImportDetails(header.split(','), rows.map(parse), tree);
    expect(matched.rows.flatMap((r) => r.unknown)).toEqual([]);
    expect(matched.rows.every((r) => r.categoryId && r.attributes.length > 0)).toBe(true);
    expect(rows[0]).toContain('"Tuned this fall, small topsheet scratch"');
  });

  it('example: leaves out what the tree lacks', () => {
    const small: ResolvedTaxonomy = { version: 1, categories: tree.categories.filter((c) => c.label === 'Poles') };
    const [, ...rows] = lines(exampleCsv(small));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatch(/^1004,/);

    const noLeki: ResolvedTaxonomy = {
      version: 1,
      categories: small.categories.map((c) => ({
        ...c, attributes: c.attributes.map((a) => ({ ...a, values: a.values?.filter((v) => v.label !== 'Leki') })),
      })),
    };
    expect(lines(exampleCsv(noLeki))[1]).not.toContain('Leki,');
  });

  it('categories and details: nested details say when, numbers give their range', () => {
    const rows = lines(detailsCsv(tree));
    expect(rows[0]).toBe('category,detail,only when,kind,values');
    expect(rows).toContain('Skis,Length,,number,70–215 cm');
    expect(rows.some((r) => r.startsWith('Bindings,Manufacturer,Type = Skis,list,'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Skis,Model,Manufacturer = Rossignol,list,'))).toBe(true);
  });

  it('quotes a value with a comma or a quote in it', () => {
    const odd: ResolvedTaxonomy = {
      version: 1,
      categories: [{
        id: 'c', label: 'Odd, "things"', scope: 'global', displayOrder: 0,
        attributes: [{ id: 'a', label: 'Kind', scope: 'global', input: 'select', displayOrder: 0, nameSlot: null,
          values: [{ id: 'v', label: '2", wide', scope: 'global', displayOrder: 0, attributes: [] }] }],
      }],
    };
    expect(lines(detailsCsv(odd))[1]).toBe('"Odd, ""things""",Kind,,list,"2"", wide"');
  });
});
