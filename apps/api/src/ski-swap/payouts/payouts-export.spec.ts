import ExcelJS from 'exceljs';
import { lineStatusLabel, payoutsWorkbook, runLabel, skuList, type PayoutExportSeller } from './payouts-export';

const row = (over: Partial<PayoutExportSeller> = {}): PayoutExportSeller => ({
  name: 'Carrie Will', business: false, email: 'carrie@example.com', phone: '+18025550100',
  street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672',
  method: 'PAYPAL', paidTo: 'carrie@example.com', skus: [{ sku: '73190', quantity: 1 }], items: 1,
  grossCents: 2000, commissionCents: 400, netCents: 1600, status: 'Paid', run: { kind: 'PAYPAL', createdAt: new Date('2026-10-20T22:57:00Z') },
  note: null, changedSincePaidCents: 0, ...over,
});

describe('the Payouts export', () => {
  it('lists the tickets in one cell, by number, with units', () => {
    expect(skuList([{ sku: '87025', quantity: 1 }, { sku: '9001', quantity: 1 }, { sku: '73190', quantity: 1 }, { sku: '87025', quantity: 1 }])).toBe('9001, 73190, 87025 ×2');
    expect(skuList([])).toBe('');
  });

  it('says a payment’s status as the run’s page does', () => {
    expect([lineStatusLabel('PENDING', 'PAYPAL'), lineStatusLabel('SENT', 'PAYPAL'), lineStatusLabel('EXPORTED', 'CHECK'), lineStatusLabel('UNCLAIMED', 'PAYPAL')])
      .toEqual(['Needs review', 'Paid', 'Check exported', 'Unclaimed']);
  });

  it('names a run by its kind and the day it was made there', () => {
    expect(runLabel({ kind: 'PAYPAL', createdAt: new Date('2026-10-21T01:00:00Z') }, 'America/New_York')).toBe('PayPal run, Oct 20');
  });

  it('writes a row per seller, with the arithmetic as money, and the totals on About', async () => {
    const content = await payoutsWorkbook(
      [row(), row({ name: 'Sara Finan', method: 'DONATE', paidTo: null, commissionCents: 2000, netCents: 0, status: 'Donated to the patrol', run: null, changedSincePaidCents: -500 })],
      { swap: 'Ski Swap 2026', scope: 'Every seller with sales', exportedBy: 'Staff', at: new Date('2026-10-20T12:00:00Z'), timeZone: 'America/New_York' },
    );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(content as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('Payouts')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'Seller', 'Type', 'Email', 'Phone', 'Street', 'City', 'State', 'ZIP', 'Payout method', 'Paid to', 'SKUs', 'Items',
      'Subtotal', 'Patrol take', 'Total', 'Status', 'Run', 'Note', 'Changed since paid']);
    expect(ws.getRow(2).values).toEqual([undefined, 'Carrie Will', 'Individual', 'carrie@example.com', '+18025550100', '12 Summit Rd', 'Stowe', 'VT', '05672',
      'PayPal', 'carrie@example.com', '73190', 1, 20, 4, 16, 'Paid', 'PayPal run, Oct 20']);
    expect([ws.getRow(3).getCell(9).value, ws.getRow(3).getCell(15).value, ws.getRow(3).getCell(19).value]).toEqual(['Donating', 0, -5]);
    const about = wb.getWorksheet('About')!;
    expect([about.getCell('B3').value, about.getCell('B4').value, about.getCell('B5').value, about.getCell('B6').value]).toEqual([2, 40, 24, 16]);
  });
});
