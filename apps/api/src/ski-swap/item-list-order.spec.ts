import { searchedField, sortRows, type SortRow } from './item-list-order';

const row = (sku: string, over: Partial<SortRow> = {}): SortRow => ({
  id: sku, sku, name: `Item #${sku}`, priceCents: 1000, sellerName: null, hasPrintedTag: true, ...over,
});
const skus = (rows: SortRow[]) => rows.map((r) => r.sku);

describe('sorting the Items page (Plan 39 D3)', () => {
  it('orders SKUs as numbers, not text', () => {
    const rows = [row('100'), row('9'), row('67000')];
    expect(skus(sortRows(rows, 'sku', 'asc'))).toEqual(['9', '100', '67000']);
    expect(skus(sortRows(rows, 'sku', 'desc'))).toEqual(['67000', '100', '9']);
  });

  it('puts no price and no seller last, whichever way', () => {
    const rows = [row('1', { priceCents: null }), row('2', { priceCents: 500 }), row('3', { priceCents: 9000 })];
    expect(skus(sortRows(rows, 'price', 'asc'))).toEqual(['2', '3', '1']);
    expect(skus(sortRows(rows, 'price', 'desc'))).toEqual(['3', '2', '1']);
    const sellers = [row('1'), row('2', { sellerName: 'Nordic' }), row('3', { sellerName: 'alpine' })];
    expect(skus(sortRows(sellers, 'seller', 'asc'))).toEqual(['3', '2', '1']);
  });

  it('sorts names without regard to case, ties by SKU', () => {
    const rows = [row('3', { name: 'skis' }), row('2', { name: 'Boots' }), row('1', { name: 'boots' })];
    expect(skus(sortRows(rows, 'name', 'asc'))).toEqual(['1', '2', '3']);
  });

  it('groups printed and unprinted tags', () => {
    const rows = [row('1'), row('2', { hasPrintedTag: false }), row('3')];
    expect(skus(sortRows(rows, 'tag', 'asc'))).toEqual(['2', '1', '3']);
  });
});

describe('a search with no sort asked for', () => {
  const r = (sku: string, name: string) => ({ sku, name });
  it('sorts by SKU when it matches SKUs', () => {
    expect(searchedField([r('67012', 'Skis'), r('9', 'Boots 670')], '670')).toBe('sku');
  });
  it('by name when it matches names and no SKU', () => {
    expect(searchedField([r('67012', 'Rossignol Skis'), r('9', 'Boots')], 'ROSSIGNOL')).toBe('name');
  });
  it('by seller when it matched only sellers', () => {
    expect(searchedField([r('67012', 'Skis')], 'dana')).toBe('seller');
  });
});
