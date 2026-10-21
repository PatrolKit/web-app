import ExcelJS from 'exceljs';
import type { PosSaleLine } from './pos/pos.adapter';
import { netOf } from './sales-heatmap';
import { receiptOf } from './sales-check.service';

/**
 * The Items export (a spreadsheet of every item matching the page's filters),
 * kept pure so it can be tested: each item's row, from sales read fresh from
 * Square, and the workbook.
 */

export interface ExportItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  sellerName: string | null;
  sellerPhone: string | null;
  sellerEmail: string | null;
  priceCents: number | null;
  quantity: number;
  squareVariationId: string | null;
  consigned: boolean;
  hasPrintedTag: boolean;
  donateProceeds: boolean;
  pickedUpAt: Date | null;
  pickedUpBy: string | null;
}

/** A live exchange, as the export names it (Plan 49): both tickets, whether or not both are exported. */
export interface ExportExchange {
  returnedItemId: string;
  replacementItemId: string;
  returnedSku: string;
  replacementSku: string;
}

export type ExportStatus = 'For sale' | 'Sold' | 'Picked up' | 'Not yet received' | 'Not in Square';

export interface ExportRow {
  sku: string;
  name: string;
  description: string | null;
  category: string | null;
  sellerName: string | null;
  sellerPhone: string | null;
  sellerEmail: string | null;
  priceCents: number | null;
  quantity: number;
  status: ExportStatus;
  unitsSold: number;
  collectedCents: number;
  lastSoldAt: Date | null;
  receipt: string | null;
  tagPrinted: boolean;
  donated: boolean;
  pickedUpAt: Date | null;
  pickedUpBy: string | null;
  exchange: string | null;
}

/**
 * One row per item, in the order given. `lines` are the swap's sales after
 * Sales check and exchanges (`attributeSales`), so a sale counts for the item
 * it belongs to. Status goes by those sales, as the Sold and For sale filters
 * do: an item is sold when its sales cover every unit.
 */
export function exportRows(items: ExportItem[], lines: PosSaleLine[], exchanges: ExportExchange[]): ExportRow[] {
  const byVariation = new Map<string, { units: number; cents: number; last: PosSaleLine | null }>();
  for (const l of lines) {
    const { units, cents } = netOf(l);
    const t = byVariation.get(l.variationId) ?? { units: 0, cents: 0, last: null };
    t.units += units;
    t.cents += cents;
    if (units > 0 && (!t.last || l.soldAt > t.last.soldAt)) t.last = l;
    byVariation.set(l.variationId, t);
  }
  const exchangeOf = new Map<string, string>();
  for (const e of exchanges) {
    exchangeOf.set(e.replacementItemId, `Went out for ${e.returnedSku}`);
    exchangeOf.set(e.returnedItemId, `Came back for ${e.replacementSku}`);
  }
  return items.map((i) => {
    const sold = (i.squareVariationId ? byVariation.get(i.squareVariationId) : undefined) ?? { units: 0, cents: 0, last: null };
    const status: ExportStatus = i.pickedUpAt ? 'Picked up'
      : !i.consigned ? 'Not yet received'
        : !i.squareVariationId ? 'Not in Square'
          : sold.units >= i.quantity ? 'Sold'
            : 'For sale';
    return {
      sku: i.sku, name: i.name, description: i.description, category: i.category,
      sellerName: i.sellerName, sellerPhone: i.sellerPhone, sellerEmail: i.sellerEmail,
      priceCents: i.priceCents, quantity: i.quantity, status,
      unitsSold: sold.units, collectedCents: sold.cents,
      lastSoldAt: sold.last?.soldAt ?? null, receipt: receiptOf(sold.last?.paymentId ?? null),
      tagPrinted: i.hasPrintedTag, donated: i.donateProceeds,
      pickedUpAt: i.pickedUpAt, pickedUpBy: i.pickedUpBy,
      exchange: exchangeOf.get(i.id) ?? null,
    };
  });
}

/**
 * A moment as the swap's clock shows it, as a date Excel displays unchanged
 * (Excel has no time zones: it shows a date's UTC fields).
 */
export function localDate(at: Date, timeZone: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  return new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second));
}

export const MONEY = '$#,##0.00';
export const WHEN = 'mmm d, yyyy h:mm AM/PM';

/** The workbook: an Items sheet (frozen, filterable header) and an About sheet saying what it holds. */
export async function exportWorkbook(rows: ExportRow[], about: { swap: string; filters: string; exportedBy: string; at: Date; timeZone: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PatrolKit';
  wb.created = about.at;
  const ws = wb.addWorksheet('Items', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'SKU', key: 'sku', width: 12 },
    { header: 'Name', key: 'name', width: 34 },
    { header: 'Description', key: 'description', width: 30 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Seller', key: 'sellerName', width: 24 },
    { header: 'Seller phone', key: 'sellerPhone', width: 16 },
    { header: 'Seller email', key: 'sellerEmail', width: 28 },
    { header: 'Price', key: 'price', width: 10, style: { numFmt: MONEY } },
    { header: 'Quantity', key: 'quantity', width: 9 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Units sold', key: 'unitsSold', width: 10 },
    { header: 'Collected', key: 'collected', width: 11, style: { numFmt: MONEY } },
    { header: 'Last sold', key: 'lastSoldAt', width: 20, style: { numFmt: WHEN } },
    { header: 'Receipt #', key: 'receipt', width: 10 },
    { header: 'Tag printed', key: 'tagPrinted', width: 11 },
    { header: 'Donated', key: 'donated', width: 9 },
    { header: 'Picked up', key: 'pickedUpAt', width: 20, style: { numFmt: WHEN } },
    { header: 'Picked up by', key: 'pickedUpBy', width: 18 },
    { header: 'Exchange', key: 'exchange', width: 22 },
  ];
  for (const r of rows) {
    ws.addRow({
      ...r,
      // Text, so a SKU like 00123 keeps its zeros and 87344 isn't summed.
      sku: r.sku,
      price: r.priceCents === null ? null : r.priceCents / 100,
      collected: r.collectedCents / 100,
      lastSoldAt: r.lastSoldAt ? localDate(r.lastSoldAt, about.timeZone) : null,
      pickedUpAt: r.pickedUpAt ? localDate(r.pickedUpAt, about.timeZone) : null,
      tagPrinted: r.tagPrinted ? 'Yes' : 'No',
      donated: r.donated ? 'Yes' : 'No',
    });
  }
  ws.getColumn('sku').numFmt = '@';
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  const info = wb.addWorksheet('About');
  info.columns = [{ width: 18 }, { width: 60 }];
  info.addRows([
    ['Swap', about.swap],
    ['Items', rows.length],
    ['Filters', about.filters || 'None: every item'],
    ['Exported by', about.exportedBy],
    ['Exported at', localDate(about.at, about.timeZone)],
    ['Sales', 'Read from Square when exported, after refunds, Sales check decisions and exchanges.'],
  ]);
  info.getCell('B5').numFmt = WHEN;
  info.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
