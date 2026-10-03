import { describe, expect, it } from 'vitest';
import { missingItemFields } from './SwapItemsPanel';

/** Add or Save stays disabled until the item has what it needs. */
describe('what the item form still needs', () => {
  const staffAdd = { picksSeller: true, editing: false };
  const filled = { priceDollars: '25', quantity: '1', sellerId: 'seller-1' };

  it('nothing, once there’s a price and a seller', () => {
    expect(missingItemFields(filled, staffAdd)).toEqual([]);
  });

  it('a price and a seller on an empty staff form', () => {
    expect(missingItemFields({ priceDollars: '', quantity: '1', sellerId: '' }, staffAdd))
      .toEqual(['a price', 'a seller']);
  });

  it('a price that rounds to more than nothing', () => {
    for (const price of ['0', '0.00', '0.004', '.']) {
      expect(missingItemFields({ ...filled, priceDollars: price }, staffAdd)).toEqual(['a price']);
    }
    expect(missingItemFields({ ...filled, priceDollars: '0.01' }, staffAdd)).toEqual([]);
  });

  it('no seller on a seller’s own form, which has no picker', () => {
    expect(missingItemFields({ ...filled, sellerId: '' }, { picksSeller: false, editing: false })).toEqual([]);
  });

  it('a quantity of at least one when editing', () => {
    expect(missingItemFields({ ...filled, quantity: '0' }, { ...staffAdd, editing: true })).toEqual(['a quantity']);
    expect(missingItemFields({ ...filled, quantity: '' }, { ...staffAdd, editing: true })).toEqual(['a quantity']);
  });
});
