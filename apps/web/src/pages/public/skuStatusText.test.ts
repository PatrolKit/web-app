import { describe, expect, it } from 'vitest';
import { statusText } from './skuStatusText';

describe('a SKU’s status in words', () => {
  const item = { sku: '67169', name: 'Skis' };

  it('says each status plainly', () => {
    expect(statusText({ ...item, status: 'sold' }).text).toBe('Sold');
    expect(statusText({ ...item, status: 'for_sale' }).text).toBe('For sale');
    expect(statusText({ ...item, status: 'not_received' }).text).toBe('Not checked in yet');
    expect(statusText({ ...item, status: 'unknown' }).text).toMatch(/can’t check right now/);
  });

  it('counts units sold of several', () => {
    expect(statusText({ ...item, status: 'for_sale', soldCount: 2, quantity: 3 }).text).toBe('2 of 3 sold');
  });
});
