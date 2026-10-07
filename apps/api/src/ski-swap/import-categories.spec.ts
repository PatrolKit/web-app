import type { ResolvedTaxonomy } from '../contracts/taxonomy.contracts';
import { ItemService } from './item.service';

/**
 * Categories and details through the importer (Plan 42): refused first,
 * listed, and written as matched once the uploader imports anyway.
 */

const tree: ResolvedTaxonomy = {
  version: 1,
  categories: [{
    id: 'skis', label: 'Skis', scope: 'global', displayOrder: 0,
    attributes: [{
      id: 'make', label: 'Manufacturer', scope: 'global', input: 'select', displayOrder: 0, nameSlot: 10,
      values: [{ id: 'volkl', label: 'Volkl', scope: 'global', displayOrder: 0, attributes: [] }],
    }],
  }],
};

type Row = { line: number; sku: string; outcome: string; itemId?: string; generated?: boolean; error?: string };

function importer(checked: Row[]) {
  const patched: { id: string; data: Record<string, unknown> }[] = [];
  const created: Record<string, unknown>[] = [];
  const reads = { resolve: 0, answerNodes: 0 };
  const taxonomy = {
    resolve: async () => { reads.resolve++; return tree; },
    answerNodes: async () => { reads.answerNodes++; return [{ id: 'node' }]; },
  };
  const service = new ItemService(
    {
      skiSwap: { findFirst: async () => ({ id: 'swap-1', allowPrintWeb: true, allowLegacyWeb: true, locationId: '' }) },
      swapItem: { update: async () => ({}) },
    } as never,
    { forOrg: async () => null } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { checkImportRows: async () => checked.map((r) => ({ ...r })) } as never,
    taxonomy as never,
  );
  const stub = service as unknown as Record<string, unknown>;
  stub.patch = async (_o: string, _s: string, id: string, data: Record<string, unknown>) => { patched.push({ id, data }); return {}; };
  stub.create = async (_o: string, _s: string, data: Record<string, unknown>) => { created.push(data); return { id: `new-${created.length}`, sku: String(data.sku ?? 'GEN') }; };
  stub.soldAmong = async () => new Set();
  return { service, patched, created, reads };
}

const ticket = (n: number, line: number): Row => ({ line, sku: String(n), outcome: 'ok', itemId: `t${n}` });
const headers = ['ticket', 'name', 'category', 'Manufacturer'];
const row = (sku: string, name: string, category: string, make: string) =>
  ({ sku, name, priceCents: 4500, cells: [sku, name, category, make] });

describe('an import with categories and details (Plan 42)', () => {
  const file = [row('101', 'Volkl Mantra 84 177', 'Skis', 'Volkl'), row('102', 'Rossi skis', 'Skis', 'Rossi'), row('103', 'Sled', 'Toboggan', '')];
  const checked = [ticket(101, 2), ticket(102, 3), ticket(103, 4)];

  it('refuses a file with unknowns, writing nothing and listing them', async () => {
    const t = importer(checked);
    const result = await t.service.importItems('org-1', 'swap-1', 'seller-1', file, { selfService: false, headers });
    expect(result.refused).toBe('unknown');
    expect(t.patched).toHaveLength(0);
    expect(result.rows.map((r) => r.unknown ?? [])).toEqual([
      [],
      [{ column: 'Manufacturer', value: 'Rossi', reason: 'unknown_value', category: 'Skis' }],
      [{ column: 'category', value: 'Toboggan', reason: 'unknown_category' }],
    ]);
  });

  it('imports anyway: what matched is written, the unknowns aren’t', async () => {
    const t = importer(checked);
    const result = await t.service.importItems('org-1', 'swap-1', 'seller-1', file, { selfService: false, headers, acceptUnknown: true });
    expect(result.refused).toBeNull();
    expect(result.rows.map((r) => r.outcome)).toEqual(['updated', 'updated', 'updated']);
    expect(t.patched.map((p) => [p.id, p.data.categoryId, p.data.attributes])).toEqual([
      ['t101', 'skis', [{ attributeId: 'make', valueId: 'volkl' }]],
      ['t102', 'skis', []],
      // An unknown category leaves the row as it was: its name and price only.
      ['t103', undefined, undefined],
    ]);
  });

  it('keeps the file’s name as the tag name, beside the details', async () => {
    const t = importer([ticket(101, 2)]);
    await t.service.importItems('org-1', 'swap-1', 'seller-1', [file[0]], { selfService: false, headers });
    expect(t.patched[0].data).toMatchObject({ name: 'Volkl Mantra 84 177', categoryId: 'skis', priceCents: 4500, deferPos: true });
  });

  it('composes the name when the file’s only repeats the category, so details reach the tag', async () => {
    const t = importer([ticket(101, 2), ticket(102, 3)]);
    await t.service.importItems('org-1', 'swap-1', 'seller-1', [row('101', 'Skis', 'Skis', 'Volkl'), row('102', 'ski', 'Skis', 'Volkl')], { selfService: false, headers });
    expect(t.patched.map((p) => p.data.name)).toEqual([undefined, undefined]);
    expect(t.patched[0].data).toMatchObject({ categoryId: 'skis' });
  });

  it('reads the tree once for the whole file', async () => {
    const t = importer(checked);
    await t.service.importItems('org-1', 'swap-1', 'seller-1', file, { selfService: false, headers, acceptUnknown: true });
    expect(t.reads).toEqual({ resolve: 1, answerNodes: 1 });
    expect(t.patched[0].data.taxonomyNodes).toEqual([{ id: 'node' }]);
  });

  it('refuses row errors even when importing anyway, listing unknowns beside them', async () => {
    const t = importer([ticket(101, 2), { line: 3, sku: '999', outcome: 'error', error: '999 isn’t one of this seller’s tickets.' }]);
    const result = await t.service.importItems('org-1', 'swap-1', 'seller-1',
      [row('101', 'Rossi', 'Skis', 'Rossi'), row('999', 'x', 'Skis', 'Volkl')], { selfService: false, headers, acceptUnknown: true });
    expect(result.refused).toBe('errors');
    expect(result.rows[0].unknown).toHaveLength(1);
    expect(t.patched).toHaveLength(0);
  });

  it('names a new row by the file, through printedName, when it has a category', async () => {
    const t = importer([{ line: 2, sku: '', outcome: 'ok', generated: true }, { line: 3, sku: '', outcome: 'ok', generated: true }]);
    await t.service.importItems('org-1', 'swap-1', 'seller-1',
      [row('', 'Volkl Mantra', 'Skis', 'Volkl'), row('', 'Plain thing', '', '')], { selfService: false, headers, generateSkus: true });
    expect(t.created[0]).toMatchObject({ printedName: 'Volkl Mantra', categoryId: 'skis' });
    expect(t.created[1]).toMatchObject({ fallbackName: 'Plain thing' });
    expect(t.created[1].categoryId).toBeUndefined();
  });

  it('leaves an existing description alone for a row without a category', async () => {
    const t = importer([ticket(101, 2)]);
    await t.service.importItems('org-1', 'swap-1', 'seller-1', [row('101', 'Boots', '', '')], { selfService: false, headers });
    expect(t.patched[0].data).not.toHaveProperty('categoryId');
    expect(t.patched[0].data).not.toHaveProperty('attributes');
  });

  it('reports a row that fails to write, and writes the rest', async () => {
    const t = importer([ticket(101, 2), ticket(102, 3)]);
    const patch = (t.service as unknown as Record<string, unknown>).patch as (...args: unknown[]) => Promise<unknown>;
    (t.service as unknown as Record<string, unknown>).patch = async (...args: unknown[]) => {
      if (args[2] === 't101') throw new (await import('@nestjs/common')).BadRequestException('"Volkl" is no longer available');
      return patch(...args);
    };
    const result = await t.service.importItems('org-1', 'swap-1', 'seller-1', [file[0], row('102', 'Skis', 'Skis', 'Volkl')], { selfService: false, headers });
    expect(result.refused).toBeNull();
    expect(result.rows.map((r) => [r.outcome, r.error])).toEqual([['error', '"Volkl" is no longer available'], ['updated', undefined]]);
    expect(t.patched.map((p) => p.id)).toEqual(['t102']);
  });

  it('names columns it ignored', async () => {
    const t = importer([ticket(101, 2)]);
    const result = await t.service.importItems('org-1', 'swap-1', 'seller-1',
      [{ sku: '101', priceCents: 4500, cells: ['101', 'U'] }], { selfService: false, headers: ['ticket', 'NEW/USED?'] });
    expect(result.ignoredColumns).toEqual(['NEW/USED?']);
    expect(result.refused).toBeNull();
  });
});
