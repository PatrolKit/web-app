import { describe, expect, it } from 'vitest';
import type { ItemResponse } from '../../lib/api.types';
import { sortItems } from './SwapItemsPanel';

const item = (sku: string, over: Partial<ItemResponse> = {}): ItemResponse => ({
  id: sku, sku, name: `Item #${sku}`, priceCents: 1000, seller: null, hasPrintedTag: true,
  consignedAt: '2026-10-01T00:00:00.000Z', squareSynced: true, inventoryKnown: true, originalQuantity: 1, inStock: 1, soldCount: 0,
  ...over,
} as ItemResponse);

const skus = (xs: ItemResponse[]) => xs.map((x) => x.sku);

describe('sorting the items table', () => {
  it('orders SKUs as numbers, not text', () => {
    const rows = [item('100'), item('9'), item('67000')];
    expect(skus(sortItems(rows, 'sku', 'asc'))).toEqual(['9', '100', '67000']);
    expect(skus(sortItems(rows, 'sku', 'desc'))).toEqual(['67000', '100', '9']);
  });

  it('puts an item with no price or no seller last, whichever way', () => {
    const rows = [item('1', { priceCents: null }), item('2', { priceCents: 500 }), item('3', { priceCents: 9000 })];
    expect(skus(sortItems(rows, 'price', 'asc'))).toEqual(['2', '3', '1']);
    expect(skus(sortItems(rows, 'price', 'desc'))).toEqual(['3', '2', '1']);
    const sellers = [item('1'), item('2', { seller: { id: 'b', displayName: 'Nordic', phone: null } }), item('3', { seller: { id: 'a', displayName: 'alpine', phone: null } })];
    expect(skus(sortItems(sellers, 'seller', 'asc'))).toEqual(['3', '2', '1']);
  });

  it('orders status by where the item is in its life, ties by SKU', () => {
    const rows = [item('5'), item('4', { consignedAt: null }), item('3', { inStock: 0, soldCount: 1 }), item('2', { consignedAt: null })];
    expect(skus(sortItems(rows, 'status', 'asc'))).toEqual(['2', '4', '5', '3']);
  });

  it('sorts names without regard to case', () => {
    const rows = [item('1', { name: 'skis' }), item('2', { name: 'Boots' }), item('3', { name: 'Jacket' })];
    expect(skus(sortItems(rows, 'name', 'asc'))).toEqual(['2', '3', '1']);
  });
});
