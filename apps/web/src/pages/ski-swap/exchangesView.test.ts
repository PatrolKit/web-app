import { describe, expect, it } from 'vitest';
import type { ExchangeItem, ExchangeLookupLine, SwapExchangeResponse } from '../../lib/api.types';
import {
  comingBackSide, differenceShort, differenceText, goingOutSide, lookupQuery, matches, recordedText, sellerWarning, statusOf,
} from './exchangesView';

const item = (over: Partial<ExchangeItem> = {}): ExchangeItem => ({
  id: 'item-87344', sku: '87344', name: 'Leki poles', priceCents: 1900, sellerId: 'lm', sellerName: 'Little Mountain', deleted: false, ...over,
});

const line: ExchangeLookupLine = {
  orderId: 'o', lineUid: 'l1', receipt: 'Gq00', soldAt: '2026-10-09T15:00:00Z', collectedCents: 1900,
  item: item(), exchange: null, paidInRun: null, links: { sale: 'https://app.squareup.com/x' },
};

const exchange = (over: Partial<SwapExchangeResponse> = {}): SwapExchangeResponse => ({
  id: 'ex', status: 'live', orderId: 'o', lineUid: 'l1', receipt: 'Gq00',
  returned: item(), replacement: item({ id: 'item-87339', sku: '87339' }),
  returnedPriceCents: 1900, replacementPriceCents: 1900, differenceCents: 0, note: null, stockSynced: true,
  supersedesId: null, supersededById: null, recordedByName: 'Pat', recordedAt: '2026-10-10T10:00:00Z',
  cancelledByName: null, cancelledAt: null, cancelReason: null, links: { sale: null }, ...over,
});

describe('the find box', () => {
  it('reads a ticket, a receipt, or a four-digit number as either', () => {
    expect(lookupQuery('87344')).toEqual({ ticket: '87344' });
    expect(lookupQuery(' #Gq00 ')).toEqual({ receipt: 'Gq00' });
    expect(lookupQuery('1234')).toEqual({ receipt: '1234', ticket: '1234' });
    expect(lookupQuery('')).toBeNull();
    expect(lookupQuery('Gq00Q')).toBeNull();
  });
});

describe('the card and its warnings', () => {
  it('shows the sale coming back, and asks for the item going out until one is picked', () => {
    const left = comingBackSide(line);
    expect(left.fields.map((f) => [f.label, f.value])).toEqual([
      ['Ticket', '87344'], ['Item', 'Leki poles'], ['Seller', 'Little Mountain'], ['Price', '$19.00'], ['Receipt', '#Gq00'],
      ['Sold', expect.stringContaining('paid $19.00')],
    ]);
    expect(goingOutSide(null).empty).toBe('Pick the item the customer is leaving with.');
    expect(goingOutSide(item({ priceCents: null })).fields.find((f) => f.label === 'Price')).toMatchObject({ value: 'Unpriced', warn: true });
  });

  it('says who pays a difference, and warns when the seller changes', () => {
    expect(differenceText(0)).toBe('Same price: nothing changes hands.');
    expect(differenceText(1200)).toMatch(/^The patrol absorbs \$12\.00/);
    expect(differenceText(-500)).toMatch(/^The patrol keeps \$5\.00/);
    expect(differenceText(null)).toBeNull();
    expect(sellerWarning(item(), item())).toBeNull();
    expect(sellerWarning(item(), item({ sellerId: 'other', sellerName: 'Another Seller' })))
      .toBe('Different sellers: the sale and its payout move from Little Mountain to Another Seller.');
  });

  it('says what was recorded', () => {
    expect(recordedText(line, item({ sku: '87339' }))).toBe('Recorded: 87344 back for sale; 87339 sold on receipt #Gq00.');
  });
});

describe('the list', () => {
  it('names each state', () => {
    expect(statusOf(exchange()).label).toBe('Live');
    expect(statusOf(exchange({ stockSynced: false })).label).toBe('Square’s stock not updated');
    expect(statusOf(exchange({ status: 'superseded' })).label).toBe('Replaced by a later exchange');
    expect(statusOf(exchange({ status: 'cancelled', stockSynced: false })).label).toBe('Cancelled');
    expect([differenceShort(0), differenceShort(1200), differenceShort(-500), differenceShort(null)])
      .toEqual(['Same price', 'Patrol absorbed $12.00', 'Patrol kept $5.00', null]);
  });

  it('finds an exchange by either ticket, the receipt, or a seller', () => {
    expect(['87339', '#gq00', 'little', ''].map((q) => matches(exchange(), q))).toEqual([true, true, true, true]);
    expect(matches(exchange(), '99999')).toBe(false);
  });
});
