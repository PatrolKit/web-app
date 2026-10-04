import { receiptEmail, receiptSms } from './receipt-templates';
import type { ReceiptView } from './receipt.service';

const view = (over: Partial<ReceiptView> = {}): ReceiptView => ({
  id: 'r1',
  token: 'Xk3abcdefghijklmnopqrstuvwxyz012',
  orgName: 'Stowe Patrol',
  orgLogoUrl: null,
  logoImageUrl: null,
  swapTitle: 'Fall Swap',
  sellerName: 'Dana Reyes',
  payoutLabel: 'Check',
  totalCents: 13500,
  itemCount: 2,
  unpricedCount: 0,
  createdAt: new Date('2026-09-17T13:42:00Z'),
  timeZone: 'America/New_York',
  url: 'https://skiswap.patrolkit.io/r/Xk3abcdefghijklmnopqrstuvwxyz012',
  trackUrl: 'https://skiswap.patrolkit.io/s/seller123',
  brandMarkUrl: 'https://skiswap.patrolkit.io/logo-mark.png',
  layout: { mode: 'ITEMIZED', show: { sku: true, name: true, price: true }, link: { url: 'https://skiswap.patrolkit.io/s/seller123', kind: 'SELLER_STATUS' }, print: { paperSize: '62x100' }, finePrint: null },
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
  it('gives the check-in time in the swap’s zone, and says which', () => {
    // 13:42 UTC on Sep 17 is 9:42 in the morning in Vermont.
    expect(receiptEmail(view())).toContain('Sep 17, 2026, 9:42 AM EDT');
    expect(receiptEmail(view({ timeZone: 'America/Denver' }))).toContain('Sep 17, 2026, 7:42 AM MDT');
  });

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

  /**
   * Light is what Gmail and Outlook for Windows will show, because they ignore
   * the media query entirely — so the base has to be the light one and the dark
   * rules have to be the override, not the other way round.
   */
  describe('theme', () => {
    it('declares both schemes so a client does not invert it itself', () => {
      const html = receiptEmail(view());
      expect(html).toContain('name="color-scheme" content="light dark"');
      expect(html).toContain('name="supported-color-schemes" content="light dark"');
    });

    it('is light in the base styles and dark only under the query', () => {
      const html = receiptEmail(view());
      const query = html.indexOf('@media (prefers-color-scheme: dark)');
      expect(query).toBeGreaterThan(-1);
      // The page's own background is the light one, stated inline where no
      // client can strip it.
      expect(html).toContain('<body class="page" style="margin: 0; padding: 0; background: #f6f7f9;">');
      expect(html.slice(query)).toContain('#1a1a1a');
    });

    /**
     * Several clients drop a <style> block. Every color therefore has to be
     * inline as well, or those clients render unstyled text on white.
     */
    it('carries the light colors inline, not only in the style block', () => {
      const html = receiptEmail(view());
      const body = html.slice(html.indexOf('<body'));
      expect(body).toContain('color: #111827');
      expect(body).toContain('background: #ffffff');
    });
  });

  describe('logo', () => {
    it('shows the org mark when there is a fetchable URL', () => {
      const html = receiptEmail(view({ logoImageUrl: 'https://skiswap.patrolkit.io/api/v1/public/orgs/o1/logo' }));
      expect(html).toContain('<img src="https://skiswap.patrolkit.io/api/v1/public/orgs/o1/logo"');
    });

    /**
     * `orgLogoUrl` is a `data:` URI, which mail clients strip. Rendering it
     * would produce a broken-image icon beside the club's name, which is worse
     * than no logo.
     */
    it('never falls back to the stored data: URI', () => {
      const html = receiptEmail(view({ orgLogoUrl: 'data:image/png;base64,AAAA', logoImageUrl: null }));
      expect(html).not.toContain('data:image');
      // The PatrolKit mark at the foot is an image too, so "no <img> at all"
      // is no longer the same claim. What matters is that the org's slot is
      // empty rather than pointing at something a client will not render.
      const images = html.match(/<img[^>]*>/g) ?? [];
      expect(images).toHaveLength(1);
      expect(images[0]).toContain(view().brandMarkUrl);
    });
  });

  describe('actions', () => {
    /** The receipt is already in the body; a button to go and read it is noise. */
    it('has no button back to the receipt it already is', () => {
      const html = receiptEmail(view());
      expect(html).not.toContain('View this receipt');
      expect(html).not.toContain('View receipt');
    });

    it('keeps the link at the foot for forwarding and keeping', () => {
      expect(receiptEmail(view())).toContain(view().url);
    });

    /** The one thing the email cannot do itself: say what has happened since. */
    it('sends the button to the seller\'s live page, not to this receipt', () => {
      const html = receiptEmail(view());
      expect(html).toContain('>Click here to check the status of your items</a>');
      const button = html.slice(html.indexOf('Click here to check the status of your items') - 400, html.indexOf('Click here to check the status of your items'));
      expect(button).toContain('https://skiswap.patrolkit.io/s/seller123');
    });
  });

  describe('payout', () => {
    it('is a panel rather than a line of small print', () => {
      const html = receiptEmail(view({ payoutLabel: 'Venmo — @dana' }));
      expect(html).toContain('Payment goes to');
      expect(html).toContain('Venmo — @dana');
      // Sized and weighted to be found, with a rule that survives a client
      // dropping the background fill.
      const panel = html.slice(html.indexOf('Payment goes to') - 300, html.indexOf('Payment goes to') + 300);
      expect(panel).toContain('border-left: 4px solid #dc2626');
      expect(panel).toContain('font-weight: 700');
    });

    it('is absent, not empty, when the seller never chose one', () => {
      expect(receiptEmail(view({ payoutLabel: null }))).not.toContain('Payment goes to');
    });
  });

  /**
   * The club's name leads this email, so PatrolKit is attributed at the foot
   * rather than competing with it at the top — the arrangement every
   * seller-facing page already uses.
   */
  it('signs off with the PatrolKit mark', () => {
    const html = receiptEmail(view());
    expect(html).toContain('Powered by');
    expect(html).toContain('https://skiswap.patrolkit.io/logo-mark.png');
    // Below the receipt, not above it.
    expect(html.indexOf('Powered by')).toBeGreaterThan(html.indexOf('Click here to check the status of your items'));
  });
});
