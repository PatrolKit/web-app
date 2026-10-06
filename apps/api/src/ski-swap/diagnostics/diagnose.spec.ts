import { diagnose, type OurItem } from './diagnose';
import type { PosCatalogItem } from '../pos/pos.adapter';

const ours = (sku: string, over: Partial<OurItem> = {}): OurItem => ({
  id: `our-${sku}`, sku, name: 'Red Skis', description: null, priceCents: 4500, consigned: true,
  squareItemId: `sq-${sku}`, squareVariationId: `sv-${sku}`, sellerName: 'Dana', ...over,
});
const square = (sku: string, over: Partial<PosCatalogItem> = {}): PosCatalogItem => ({
  itemId: `sq-${sku}`, variationId: `sv-${sku}`, sku, name: 'Red Skis', description: null,
  pricing: { type: 'fixed', cents: 4500 }, version: '1', updatedAt: null, ...over,
});
const kinds = (issues: ReturnType<typeof diagnose>) => issues.map((i) => [i.sku, i.kind, i.field]);

describe('the swap diagnostics comparison (Plan 41)', () => {
  it('finds nothing when every field matches', () => {
    expect(diagnose({ ours: [ours('1')], deleted: [], square: [square('1')] })).toEqual([]);
  });

  it('finds a SKU only in Square, and says when a deleted item of ours had it', () => {
    const [plain] = diagnose({ ours: [], deleted: [], square: [square('1')] });
    expect(plain).toMatchObject({ kind: 'only_square', ours: null });
    const [gone] = diagnose({ ours: [], deleted: [{ id: 'd1', sku: '1', name: 'Old', sellerName: 'Sam' }], square: [square('1')] });
    expect(gone).toMatchObject({ kind: 'only_square', ours: { itemId: 'd1', deleted: true, sellerName: 'Sam' } });
  });

  it('finds a consigned item only in PatrolKit, but not one still waiting to be accepted', () => {
    expect(kinds(diagnose({ ours: [ours('1')], deleted: [], square: [] }))).toEqual([['1', 'only_ours', null]]);
    expect(diagnose({ ours: [ours('2', { consigned: false })], deleted: [], square: [] })).toEqual([]);
  });

  it('finds each differing field as its own issue', () => {
    const issues = diagnose({
      ours: [ours('1', { name: 'Blue Skis', description: 'scratched', priceCents: 5000 })],
      deleted: [], square: [square('1')],
    });
    expect(kinds(issues)).toEqual([['1', 'differs', 'name'], ['1', 'differs', 'notes'], ['1', 'differs', 'price']]);
    expect(issues[2]).toMatchObject({ ours: { priceCents: 5000 }, square: { priceCents: 4500 } });
  });

  it('treats blank and missing notes alike, and trims them', () => {
    expect(diagnose({ ours: [ours('1', { description: '  ' })], deleted: [], square: [square('1', { description: null })] })).toEqual([]);
    expect(diagnose({ ours: [ours('1', { description: 'worn ' })], deleted: [], square: [square('1', { description: 'worn' })] })).toEqual([]);
  });

  it('reads a variable price as no price: right for an unpriced ticket, a difference otherwise', () => {
    const variable = square('67169', { pricing: { type: 'variable' } });
    expect(diagnose({ ours: [ours('67169', { priceCents: null })], deleted: [], square: [variable] })).toEqual([]);
    expect(kinds(diagnose({ ours: [ours('67169')], deleted: [], square: [variable] }))).toEqual([['67169', 'differs', 'price']]);
  });

  it('finds an item not linked: no stored ids, or ids pointing elsewhere', () => {
    expect(kinds(diagnose({ ours: [ours('1', { squareItemId: null, squareVariationId: null })], deleted: [], square: [square('1')] })))
      .toEqual([['1', 'not_linked', null]]);
    expect(kinds(diagnose({ ours: [ours('1', { squareItemId: 'sq-other' })], deleted: [], square: [square('1')] })))
      .toEqual([['1', 'not_linked', null]]);
  });

  it('finds an item with several problems as several issues', () => {
    expect(kinds(diagnose({ ours: [ours('1', { squareItemId: null, priceCents: 1 })], deleted: [], square: [square('1')] })))
      .toEqual([['1', 'not_linked', null], ['1', 'differs', 'price']]);
  });

  it('finds the same SKU twice in Square as one issue listing each copy', () => {
    const [twice, ...rest] = diagnose({ ours: [ours('1')], deleted: [], square: [square('1'), square('1', { itemId: 'sq-dup', variationId: 'sv-dup' })] });
    expect(rest).toEqual([]);
    expect(twice).toMatchObject({ kind: 'twice', square: { copies: [{ itemId: 'sq-1' }, { itemId: 'sq-dup' }] } });
  });

  it('gives the same fingerprint for the same values, and a new one for any change', () => {
    const run = (price: number) => diagnose({ ours: [ours('1', { priceCents: price })], deleted: [], square: [square('1')] })[0].fingerprint;
    expect(run(5000)).toBe(run(5000));
    expect(run(5000)).not.toBe(run(5100));
  });

  it('can look at only some SKUs', () => {
    const issues = diagnose({ ours: [ours('1'), ours('2')], deleted: [], square: [], onlySkus: new Set(['2']) });
    expect(kinds(issues)).toEqual([['2', 'only_ours', null]]);
  });
});
