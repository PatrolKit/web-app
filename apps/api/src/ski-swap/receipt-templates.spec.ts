import { receiptEmail, receiptSms } from './receipt-templates';
import type { ReceiptView } from './receipt.service';

const view = (over: Partial<ReceiptView> = {}): ReceiptView => ({
  id: 'r1',
  token: 'Xk3abcdefghijklmnopqrstuvwxyz012',
  orgName: 'Stowe Patrol',
  orgLogoUrl: null,
  swapTitle: 'Fall Swap',
  sellerName: 'Dana Reyes',
  payoutLabel: 'Check',
  totalCents: 13500,
  itemCount: 2,
  createdAt: new Date('2026-09-17T13:42:00Z'),
  url: 'https://skiswap.patrolkit.io/r/Xk3abcdefghijklmnopqrstuvwxyz012',
  lines: [
    { name: 'Rossignol 172cm Red Skis', sku: 'ETR-E-0001', priceCents: 4500 },
    { name: 'Snowboard', sku: 'ETR-E-0002', priceCents: 9000 },
  ],
  ...over,
});

describe('receiptSms', () => {
  it('fits one message', () => {
    expect(receiptSms(view()).length).toBeLessThanOrEqual(160);
  });

  /**
   * A truncated club name is still recognisable; a truncated URL is rubbish. So
   * the length is taken out of the name, never the link.
   */
  it('keeps the whole link when the org name is absurd', () => {
    const msg = receiptSms(view({ orgName: 'A'.repeat(200) }));
    expect(msg.length).toBeLessThanOrEqual(160);
    expect(msg).toContain('https://skiswap.patrolkit.io/r/Xk3abcdefghijklmnopqrstuvwxyz012');
  });

  it('says what is on it without being opened', () => {
    const msg = receiptSms(view());
    expect(msg).toContain('Stowe Patrol');
    expect(msg).toContain('Fall Swap');
    expect(msg).toContain('2 items');
    expect(msg).toContain('$135.00');
  });

  it('counts one item singular', () => {
    expect(receiptSms(view({ itemCount: 1 }))).toContain('1 item,');
  });
});

describe('receiptEmail', () => {
  it('carries the receipt in the body rather than only a link', () => {
    const html = receiptEmail(view());
    expect(html).toContain('Rossignol 172cm Red Skis');
    expect(html).toContain('ETR-E-0001');
    expect(html).toContain('$45.00');
    expect(html).toContain('$135.00');
  });

  /** A seller who chose where the money goes should see it said back. */
  it('names the payout destination when there is one', () => {
    expect(receiptEmail(view({ payoutLabel: 'Venmo — @dana' }))).toContain('Venmo — @dana');
    expect(receiptEmail(view({ payoutLabel: null }))).not.toContain('Payment goes to');
  });

  it('says so rather than rendering an empty table', () => {
    const html = receiptEmail(view({ lines: [], itemCount: 0, totalCents: 0 }));
    expect(html).toContain('No items were checked in');
  });

  /**
   * Item names are seller-supplied — free entry mints values nobody approved —
   * so they reach an HTML document untrusted.
   */
  it('escapes what a seller typed', () => {
    const html = receiptEmail(
      view({ lines: [{ name: '<script>alert(1)</script>', sku: 'X-1', priceCents: 100 }] }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes the seller and org names too', () => {
    const html = receiptEmail(view({ sellerName: 'A & B "quoted"', orgName: '<b>Club</b>' }));
    expect(html).toContain('A &amp; B &quot;quoted&quot;');
    expect(html).not.toContain('<b>Club</b>');
  });
});
