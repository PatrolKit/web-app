import ExcelJS from 'exceljs';
import { RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../common/decorators/require-permissions.decorator';
import { ItemController } from './item.controller';
import { exportRows, exportWorkbook, localDate, type ExportItem } from './item-export';
import type { PosSaleLine } from './pos/pos.adapter';

/** The Items export: every matching item, with sales as Square has them now. */

const item = (sku: string, over: Partial<ExportItem> = {}): ExportItem => ({
  id: `i-${sku}`, sku, name: `Item ${sku}`, description: null, category: 'Poles',
  sellerName: 'Little Mountain', sellerPhone: '+15550100000', sellerEmail: 'lm@example.com',
  priceCents: 1900, quantity: 1, squareVariationId: `v-${sku}`, consigned: true,
  hasPrintedTag: true, donateProceeds: false, pickedUpAt: null, pickedUpBy: null, ...over,
});
const sale = (variationId: string, over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId: 'o1', lineUid: 'l1', variationId, quantity: 1, collectedCents: 1900, unitPriceCents: 1900,
  refundedQuantity: 0, soldAt: new Date('2026-10-09T19:42:00Z'), paymentId: 'Gq00QHSW', ...over,
});

describe('the Items export rows', () => {
  it('says each item’s status from its sales, and what Square took', () => {
    const rows = exportRows([
      item('87339'),
      item('87344'),
      item('70001', { quantity: 2 }),
      item('70002', { consigned: false }),
      item('70003', { squareVariationId: null }),
      item('70004', { pickedUpAt: new Date('2026-10-12T20:00:00Z'), pickedUpBy: 'Pat' }),
    ], [
      sale('v-87339'),
      sale('v-70001', { orderId: 'o2', collectedCents: 1500 }),
      sale('v-87344', { orderId: 'o3', refundedQuantity: 1 }),   // refunded whole
    ], []);
    expect(rows.map((r) => [r.sku, r.status, r.unitsSold, r.collectedCents])).toEqual([
      ['87339', 'Sold', 1, 1900],
      ['87344', 'For sale', 0, 0],
      ['70001', 'For sale', 1, 1500],
      ['70002', 'Not yet received', 0, 0],
      ['70003', 'Not in Square', 0, 0],
      ['70004', 'Picked up', 0, 0],
    ]);
    expect(rows[0]).toMatchObject({ receipt: 'Gq00', lastSoldAt: new Date('2026-10-09T19:42:00Z'), sellerPhone: '+15550100000' });
    expect(rows[1]).toMatchObject({ receipt: null, lastSoldAt: null });
  });

  it('names both sides of a live exchange', () => {
    const ex = [{ returnedItemId: 'i-87344', replacementItemId: 'i-87339', returnedSku: '87344', replacementSku: '87339' }];
    expect(exportRows([item('87344'), item('87339')], [], ex).map((r) => r.exchange)).toEqual(['Came back for 87339', 'Went out for 87344']);
    // Filtered to Sold, the other side isn't exported, and is still named.
    expect(exportRows([item('87339')], [], ex).map((r) => r.exchange)).toEqual(['Went out for 87344']);
  });

  it('writes times as the swap’s clock shows them', () => {
    expect(localDate(new Date('2026-10-09T19:42:00Z'), 'America/New_York').toISOString()).toBe('2026-10-09T15:42:00.000Z');
  });
});

describe('the Items workbook', () => {
  it('has a filterable Items sheet with money as dollars and SKUs as text, and an About sheet', async () => {
    const rows = exportRows([item('87339'), item('00123', { priceCents: null })], [sale('v-87339')], []);
    const buf = await exportWorkbook(rows, { swap: 'Fall Swap', filters: 'Sold', exportedBy: 'Pat Admin', at: new Date('2026-10-11T14:00:00Z'), timeZone: 'America/New_York' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Items')!;
    expect(ws.getRow(1).getCell(1).value).toBe('SKU');
    expect(ws.getRow(2).getCell(1).value).toBe('87339');
    expect(ws.getRow(3).getCell(1).value).toBe('00123');
    expect(ws.getRow(2).getCell(8).value).toBe(19);
    expect(ws.getRow(2).getCell(8).numFmt).toBe('$#,##0.00');
    expect(ws.getRow(3).getCell(8).value).toBeNull();
    expect(ws.getRow(2).getCell(10).value).toBe('Sold');
    expect(ws.getRow(2).getCell(14).value).toBe('Gq00');
    expect(ws.autoFilter).toBeTruthy();
    const about = wb.getWorksheet('About')!;
    expect(about.getRow(2).values).toEqual([undefined, 'Items', 2]);
    expect(about.getRow(3).getCell(2).value).toBe('Sold');
  });
});

describe('the export routes', () => {
  const reflector = new Reflector();
  const route = (name: keyof ItemController) => [
    Reflect.getMetadata(METHOD_METADATA, ItemController.prototype[name]),
    reflector.get(PERMISSIONS_KEY, ItemController.prototype[name]),
  ];

  it('are open to anyone who can read the Items page', () => {
    expect(route('exportItems')).toEqual([RequestMethod.GET, ['ski_swap:report']]);
    expect(route('emailItems')).toEqual([RequestMethod.POST, ['ski_swap:report']]);
  });
});
