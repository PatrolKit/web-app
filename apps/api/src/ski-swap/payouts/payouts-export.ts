import ExcelJS from 'exceljs';
import { localDate, MONEY, WHEN } from '../item-export';

/**
 * The Payouts export's spreadsheet (pure): one row per seller, with their
 * contact details, how and where they're paid, the tickets the payout is for,
 * the arithmetic, and where the payment stands. A seller already paid shows
 * what was paid, and how much it has changed since, if it has.
 */

export interface PayoutExportSeller {
  name: string;
  business: boolean;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  method: string | null;
  /** Where it goes: an email, phone, ID or handle, or a check's address. */
  paidTo: string | null;
  /** The sold tickets it's for, each with how many units. */
  skus: { sku: string; quantity: number }[];
  items: number;
  grossCents: number;
  commissionCents: number;
  /** What the seller is paid: nothing, for one who donated. */
  netCents: number;
  status: string;
  /** The run it's in, or was last in. */
  run: { kind: string; createdAt: Date } | null;
  note: string | null;
  changedSincePaidCents: number;
}

const METHOD: Record<string, string> = { PAYPAL: 'PayPal', VENMO: 'Venmo', CHECK: 'Check', DONATE: 'Donating' };

const LINE_STATUS: Record<string, string> = {
  PENDING: 'Needs review', APPROVED: 'Approved', SENDING: 'Sending', SENT: 'Paid', UNCLAIMED: 'Unclaimed',
  ONHOLD: 'On hold', FAILED: 'Failed', RETURNED: 'Returned', CANCELLED: 'Cancelled',
};

/** A payout line's status as the run's page says it. */
export function lineStatusLabel(status: string, kind: string): string {
  if (status === 'EXPORTED') return kind === 'CHECK' ? 'Check exported' : 'Paid';
  return LINE_STATUS[status] ?? status;
}

/** "73190, 87025 ×2, 95786": by ticket number as people read them. */
export function skuList(skus: { sku: string; quantity: number }[]): string {
  const units = new Map<string, number>();
  for (const s of skus) units.set(s.sku, (units.get(s.sku) ?? 0) + s.quantity);
  return [...units]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([sku, n]) => (n > 1 ? `${sku} ×${n}` : sku))
    .join(', ');
}

/** "PayPal run, Oct 20": which run, as the Payouts page lists them. */
export function runLabel(run: { kind: string; createdAt: Date }, timeZone: string): string {
  const day = run.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
  return `${run.kind === 'PAYPAL' ? 'PayPal' : 'Check'} run, ${day}`;
}

export async function payoutsWorkbook(rows: PayoutExportSeller[], about: { swap: string; scope: string; exportedBy: string; at: Date; timeZone: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PatrolKit';
  wb.created = about.at;
  const ws = wb.addWorksheet('Payouts', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Seller', key: 'name', width: 26 },
    { header: 'Type', key: 'type', width: 11 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Street', key: 'street', width: 26 },
    { header: 'City', key: 'city', width: 14 },
    { header: 'State', key: 'state', width: 7 },
    { header: 'ZIP', key: 'zip', width: 9 },
    { header: 'Payout method', key: 'method', width: 14 },
    { header: 'Paid to', key: 'paidTo', width: 30 },
    { header: 'SKUs', key: 'skus', width: 36 },
    { header: 'Items', key: 'items', width: 7 },
    { header: 'Subtotal', key: 'gross', width: 11, style: { numFmt: MONEY } },
    { header: 'Patrol take', key: 'commission', width: 11, style: { numFmt: MONEY } },
    { header: 'Total', key: 'net', width: 11, style: { numFmt: MONEY } },
    { header: 'Status', key: 'status', width: 22 },
    { header: 'Run', key: 'run', width: 20 },
    { header: 'Note', key: 'note', width: 36 },
    { header: 'Changed since paid', key: 'changed', width: 12, style: { numFmt: MONEY } },
  ];
  for (const r of rows) {
    ws.addRow({
      name: r.name,
      type: r.business ? 'Business' : 'Individual',
      email: r.email, phone: r.phone, street: r.street, city: r.city, state: r.state, zip: r.zip,
      method: r.method ? METHOD[r.method] ?? r.method : 'Not set',
      paidTo: r.paidTo,
      skus: skuList(r.skus),
      items: r.items,
      gross: r.grossCents / 100,
      commission: r.commissionCents / 100,
      net: r.netCents / 100,
      status: r.status,
      run: r.run ? runLabel(r.run, about.timeZone) : null,
      note: r.note,
      changed: r.changedSincePaidCents ? r.changedSincePaidCents / 100 : null,
    });
  }
  ws.getColumn('zip').numFmt = '@';
  ws.getColumn('phone').numFmt = '@';
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  const sum = (f: (r: PayoutExportSeller) => number) => rows.reduce((n, r) => n + f(r), 0) / 100;
  const info = wb.addWorksheet('About');
  info.columns = [{ width: 18 }, { width: 64 }];
  info.addRows([
    ['Swap', about.swap],
    ['Payouts', about.scope],
    ['Sellers', rows.length],
    ['Subtotal', sum((r) => r.grossCents)],
    ['Patrol take', sum((r) => r.commissionCents)],
    ['Total to sellers', sum((r) => r.netCents)],
    ['Exported by', about.exportedBy],
    ['Exported at', localDate(about.at, about.timeZone)],
    ['Amounts', 'A seller already paid shows what was paid, and "Changed since paid" if it has changed since. Everyone else shows what they’re owed now.'],
  ]);
  for (const cell of ['B4', 'B5', 'B6']) info.getCell(cell).numFmt = MONEY;
  info.getCell('B8').numFmt = WHEN;
  info.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
