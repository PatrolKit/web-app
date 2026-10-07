import type { ResolvedAttribute, ResolvedTaxonomy, ResolvedValue } from '../contracts/taxonomy.contracts';
import { matchImportDetails } from './import-details';

const value = (id: string, label: string, attributes: ResolvedAttribute[] = []): ResolvedValue =>
  ({ id, label, scope: 'global', displayOrder: 0, attributes });
const select = (id: string, label: string, values: ResolvedValue[]): ResolvedAttribute =>
  ({ id, label, scope: 'global', input: 'select', displayOrder: 0, nameSlot: null, values });
const number = (id: string, label: string, over: Partial<ResolvedAttribute> = {}): ResolvedAttribute =>
  ({ id, label, scope: 'global', input: 'number', displayOrder: 0, nameSlot: null, ...over });

const tree: ResolvedTaxonomy = {
  version: 1,
  categories: [
    {
      id: 'skis', label: 'Skis', scope: 'global', displayOrder: 0,
      attributes: [
        select('skis-make', 'Manufacturer', [
          value('volkl', 'Volkl', [select('volkl-model', 'Model', [value('mantra', 'Mantra 84')])]),
          value('alpina', 'Alpina'),
          value('stockli', 'Stöckli'),
        ]),
        number('skis-len', 'Length', { unit: 'cm', min: 70, max: 215 }),
        select('skis-bind', 'Bindings included', [
          // Yes takes its details from Bindings › Type › Skis (Plan 44 D14): the
          // binding maker and model, headed "Binding Manufacturer" / "Binding Model".
          {
            ...value('yes', 'Yes', [
              select('bind-make', 'Manufacturer', [value('marker', 'Marker', [select('marker-model', 'Model', [value('griffon', 'Griffon 13 ID')])])]),
            ]),
            sameDetailsAs: { id: 'type-skis', category: 'Bindings' },
          },
          value('no', 'No'),
        ]),
      ],
    },
    {
      id: 'poles', label: 'Poles', scope: 'global', displayOrder: 1,
      attributes: [number('poles-len', 'Length', { unit: 'cm', min: 70, max: 140, step: 5 })],
    },
    {
      id: 'boots', label: 'Ski boots', scope: 'global', displayOrder: 2,
      attributes: [number('mondo', 'Mondopoint', { min: 14, max: 34 }), select('boots-color', 'Color', [value('black', 'Black')])],
    },
  ],
};

const match = (headers: string[], ...rows: string[][]) => matchImportDetails(headers, rows, tree);

describe('categories and details in an imported file (Plan 42)', () => {
  it('finds a category by its label, any case, with or without a trailing s', () => {
    const { rows } = match(['ticket', 'category'], ['1', 'skis'], ['2', 'Ski boot'], ['3', 'SKI BOOTS']);
    expect(rows.map((r) => r.categoryId)).toEqual(['skis', 'boots', 'boots']);
  });

  it('matches listed values in any case, and stores only ids', () => {
    const { rows } = match(['category', 'manufacturer', 'Bindings Included'], ['Skis', 'volkl', 'YES']);
    expect(rows[0]).toEqual({
      categoryId: 'skis',
      attributes: [{ attributeId: 'skis-make', valueId: 'volkl' }, { attributeId: 'skis-bind', valueId: 'yes' }],
      unknown: [],
    });
  });

  it('reads a ski\'s binding details from columns headed with where they came from (Plan 44 D14)', () => {
    const { rows, ignoredColumns } = match(
      ['category', 'Manufacturer', 'Bindings included', 'Binding Manufacturer', 'Binding Model'],
      ['Skis', 'Volkl', 'Yes', 'Marker', 'griffon 13 id'],
      ['Skis', 'Volkl', 'No', 'Marker', ''],
    );
    expect(ignoredColumns).toEqual([]);
    expect(rows[0].attributes).toEqual([
      { attributeId: 'skis-make', valueId: 'volkl' },
      { attributeId: 'skis-bind', valueId: 'yes' },
      { attributeId: 'bind-make', valueId: 'marker' },
      { attributeId: 'marker-model', valueId: 'griffon' },
    ]);
    // Not Yes: the binding columns need their parent.
    expect(rows[1].attributes).toEqual([{ attributeId: 'skis-make', valueId: 'volkl' }, { attributeId: 'skis-bind', valueId: 'no' }]);
    expect(rows[1].unknown[0]).toMatchObject({ column: 'Binding Manufacturer', value: 'Marker', reason: 'needs_parent', parent: 'Bindings included' });
  });

  it('ignores accents and apostrophe styles, but not abbreviations', () => {
    const { rows } = match(['category', 'Manufacturer'], ['Skis', 'Stockli'], ['Skis', 'STÖCKLI'], ['Skis', 'Stock']);
    expect(rows[0].attributes).toEqual([{ attributeId: 'skis-make', valueId: 'stockli' }]);
    expect(rows[1].attributes).toEqual([{ attributeId: 'skis-make', valueId: 'stockli' }]);
    expect(rows[2].unknown[0]).toMatchObject({ value: 'Stock', reason: 'unknown_value' });
  });

  it('matches a Model only under its Manufacturer', () => {
    const ok = match(['category', 'Manufacturer', 'Model'], ['Skis', 'Volkl', 'Mantra 84']).rows[0];
    expect(ok.attributes).toContainEqual({ attributeId: 'volkl-model', valueId: 'mantra' });

    const wrong = match(['category', 'Manufacturer', 'Model'], ['Skis', 'Alpina', 'Mantra 84']).rows[0];
    expect(wrong.unknown).toEqual([{ column: 'Model', value: 'Mantra 84', reason: 'needs_parent', category: 'Skis', parent: 'Manufacturer', under: 'Alpina' }]);

    const missing = match(['category', 'Model'], ['Skis', 'Mantra 84']).rows[0];
    expect(missing.unknown).toEqual([{ column: 'Model', value: 'Mantra 84', reason: 'needs_parent', category: 'Skis', parent: 'Manufacturer' }]);

    const notListed = match(['category', 'Manufacturer', 'Model'], ['Skis', 'Volkl', 'Kendo']).rows[0];
    expect(notListed.unknown).toEqual([{ column: 'Model', value: 'Kendo', reason: 'unknown_value', category: 'Skis', parent: 'Manufacturer', under: 'Volkl' }]);
  });

  it('reads numbers in the detail’s unit, converting inches to cm', () => {
    const { rows } = match(['category', 'Length', 'Mondopoint'], ['Skis', '163cm', ''], ['Poles', '42"', ''], ['Ski boots', '', '24.5']);
    expect(rows[0].attributes).toEqual([{ attributeId: 'skis-len', numberValue: 163 }]);
    // 42" is 106.7 cm, rounded to the poles' 5 cm steps.
    expect(rows[1].attributes).toEqual([{ attributeId: 'poles-len', numberValue: 105 }]);
    expect(rows[2].attributes).toEqual([{ attributeId: 'mondo', numberValue: 24.5 }]);
  });

  it('reports a number that isn’t one, is out of range, or falls between steps', () => {
    const { rows } = match(['category', 'Length'], ['Skis', 'long'], ['Skis', '300'], ['Poles', '107']);
    expect(rows[0].unknown[0]).toMatchObject({ column: 'Length', value: 'long', reason: 'not_a_number' });
    expect(rows[1].unknown[0]).toMatchObject({ column: 'Length', value: '300', reason: 'out_of_range' });
    expect(rows[2].unknown[0]).toMatchObject({ column: 'Length', value: '107', reason: 'off_step', step: 5 });
  });

  it('reports an unknown category and value, and keeps what did match', () => {
    const { rows } = match(['category', 'Manufacturer', 'Length'], ['Ski/Bdg', 'Volkl', '170'], ['Skis', 'Rossi', '170']);
    expect(rows[0]).toEqual({ attributes: [], unknown: [{ column: 'category', value: 'Ski/Bdg', reason: 'unknown_category' }] });
    expect(rows[1].attributes).toEqual([{ attributeId: 'skis-len', numberValue: 170 }]);
    expect(rows[1].unknown).toEqual([{ column: 'Manufacturer', value: 'Rossi', reason: 'unknown_value', category: 'Skis' }]);
  });

  it('skips a detail the row’s category doesn’t have, and a blank cell, without comment', () => {
    const { rows } = match(['category', 'Mondopoint', 'Color', 'Length'], ['Skis', '26.5', 'Black', '']);
    expect(rows[0]).toEqual({ categoryId: 'skis', attributes: [], unknown: [] });
  });

  it('leaves a row without a category undescribed', () => {
    const { rows } = match(['ticket', 'category', 'Manufacturer'], ['1', '', 'Volkl']);
    expect(rows[0]).toEqual({ attributes: [], unknown: [] });
  });

  it('ignores columns that aren’t ours or a detail, and names each once', () => {
    const { ignoredColumns } = match(['ticket', 'NEW/USED?', 'name', 'Colour', 'Color', 'color', 'price', 'details'], ['1']);
    expect(ignoredColumns).toEqual(['NEW/USED?', 'Colour', 'color']);
  });

  it('never mints: no free text in what it returns', () => {
    const { rows } = match(['category', 'Manufacturer', 'Model'], ['Skis', 'Brand new brand', 'Whatever']);
    expect(rows[0].attributes.some((a) => 'freeText' in a)).toBe(false);
  });
});
