import ExcelJS from 'exceljs';
import { sellerExportRows, sellerWorkbook, type ExportSeller } from './seller-export';
import { describe as describeFilters } from './seller-export.service';

const seller = (over: Partial<ExportSeller> = {}): ExportSeller => ({
  displayName: 'Dana Reyes', businessName: null, phone: '+18025550100', email: 'dana@example.com', emailVerifiedAt: '2026-10-01T00:00:00Z',
  street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672',
  payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL', payoutHandle: null, payoutHandleScanned: false, ...over,
});

describe('the Sellers export', () => {
  it('says how each seller is paid, where to, and whether they can be', () => {
    const rows = sellerExportRows([
      seller(),
      seller({ displayName: 'Little Mountain', businessName: 'Little Mountain', payoutMethod: 'CHECK', payoutTarget: null }),
      seller({ payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID', payoutHandle: '@dana', payoutHandleScanned: false }),
      seller({ payoutMethod: null, payoutTarget: null, street: null, city: null, state: null, zip: null }),
    ]);
    expect(rows.map((r) => [r.type, r.payout, r.paidTo, r.canBePaid])).toEqual([
      ['Individual', 'PayPal', 'dana@example.com', 'Yes'],
      ['Business', 'Check', 'Mailed to their address', 'Yes'],
      ['Individual', 'Venmo', '@dana', expect.stringMatching(/^No: /)],
      ['Individual', 'Not set', null, 'No: No mailing address; No payout method'],
    ]);
    expect(rows[0]).toMatchObject({ street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672' });
  });

  it('writes a sheet of sellers, ZIPs kept as text, and what was exported', async () => {
    const content = await sellerWorkbook(sellerExportRows([seller()]), { org: 'BMBWAV', filters: 'PayPal', exportedBy: 'Staff', at: new Date('2026-10-20T12:00:00Z'), timeZone: 'America/New_York' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(content as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Sellers')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Name', 'Type', 'Email', 'Phone', 'Payout', 'Paid to', 'Can be paid', 'Street', 'City', 'State', 'ZIP']);
    expect(ws.getRow(2).getCell(11).value).toBe('05672');
    expect(wb.getWorksheet('About')!.getCell('B3').value).toBe('PayPal');
  });

  it('names the filters it was made with', () => {
    expect(describeFilters({})).toBe('');
    expect(describeFilters({ type: 'business', payout: 'NONE', incomplete: true, search: ' smith ', sort: 'email', dir: 'desc' }))
      .toBe('business sellers · payout not set · can’t be paid · search “smith” · sorted by email, descending');
  });
});
