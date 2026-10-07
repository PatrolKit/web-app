import { publicItemStatus } from './public-item-status';

describe('an item’s public status', () => {
  const item = { consignedAt: new Date(), squareVariationId: 'sv-1', originalQuantity: 1 };

  it('says returned for an item handed back, whatever Square counts (Plan 43)', () => {
    // Out of Square, its count is none: without this it would read as sold.
    expect(publicItemStatus({ ...item, returnedAt: new Date() }, new Map())).toEqual({ status: 'returned', soldCount: null, quantity: 1 });
  });

  it('still reads sold and for sale from Square otherwise', () => {
    expect(publicItemStatus(item, new Map([['sv-1', 0]])).status).toBe('sold');
    expect(publicItemStatus(item, new Map([['sv-1', 1]])).status).toBe('for_sale');
  });
});
