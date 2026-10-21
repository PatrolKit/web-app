import ExcelJS from 'exceljs';
import { payoutGaps, type PayoutGapSeller } from '../contracts/payout-gaps';
import { localDate, WHEN } from './item-export';

/**
 * The Sellers export's spreadsheet (pure): one row per seller, with how and
 * where they're paid, whether they can be, and their mailing address.
 */

/** A seller as the export reads them: the Sellers list's response. */
export interface ExportSeller extends PayoutGapSeller {
  displayName: string;
  businessName: string | null;
  phone: string | null;
  payoutHandle: string | null;
}

export interface SellerExportRow {
  name: string;
  type: 'Business' | 'Individual';
  email: string | null;
  phone: string | null;
  payout: string;
  paidTo: string | null;
  canBePaid: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

const METHOD: Record<string, string> = { PAYPAL: 'PayPal', VENMO: 'Venmo', CHECK: 'Check', DONATE: 'Donating' };

/**
 * Where the money goes, as the payout run would send it: PayPal to the
 * verified email (or phone, or the ID typed), Venmo to the handle, a check to
 * the address. Nothing for donating or no method.
 */
function paidTo(s: ExportSeller): string | null {
  switch (s.payoutMethod) {
    case 'PAYPAL':
      return s.payoutTarget === 'EMAIL' ? s.email : s.payoutTarget === 'PHONE' ? s.phone : s.payoutHandle;
    case 'VENMO':
      return s.payoutHandle;
    case 'CHECK':
      return 'Mailed to their address';
    default:
      return null;
  }
}

export function sellerExportRows(sellers: ExportSeller[]): SellerExportRow[] {
  return sellers.map((s) => {
    const gaps = payoutGaps(s);
    return {
      name: s.displayName,
      type: s.businessName ? 'Business' : 'Individual',
      email: s.email,
      phone: s.phone,
      payout: s.payoutMethod ? METHOD[s.payoutMethod] : 'Not set',
      paidTo: paidTo(s),
      canBePaid: gaps.length === 0 ? 'Yes' : `No: ${gaps.map((g) => g.problem).join('; ')}`,
      street: s.street,
      city: s.city,
      state: s.state,
      zip: s.zip,
    };
  });
}

export async function sellerWorkbook(rows: SellerExportRow[], about: { org: string; filters: string; exportedBy: string; at: Date; timeZone: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PatrolKit';
  wb.created = about.at;
  const ws = wb.addWorksheet('Sellers', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [
    { header: 'Name', key: 'name', width: 28 },
    { header: 'Type', key: 'type', width: 11 },
    { header: 'Email', key: 'email', width: 30 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Payout', key: 'payout', width: 11 },
    { header: 'Paid to', key: 'paidTo', width: 30 },
    { header: 'Can be paid', key: 'canBePaid', width: 36 },
    { header: 'Street', key: 'street', width: 28 },
    { header: 'City', key: 'city', width: 16 },
    { header: 'State', key: 'state', width: 7 },
    { header: 'ZIP', key: 'zip', width: 9 },
  ];
  for (const r of rows) ws.addRow(r);
  // Text, so a ZIP like 05672 keeps its zero and a phone isn't a number.
  ws.getColumn('zip').numFmt = '@';
  ws.getColumn('phone').numFmt = '@';
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  const info = wb.addWorksheet('About');
  info.columns = [{ width: 18 }, { width: 60 }];
  info.addRows([
    ['Organization', about.org],
    ['Sellers', rows.length],
    ['Filters', about.filters || 'None: every seller'],
    ['Exported by', about.exportedBy],
    ['Exported at', localDate(about.at, about.timeZone)],
  ]);
  info.getCell('B5').numFmt = WHEN;
  info.getColumn(1).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
