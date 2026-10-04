import { ConflictException, NotFoundException } from '@nestjs/common';
import { assertReceiptSettings, sanitizeFinePrint, type ReceiptSettings } from './receipt-settings';
import { emailHint, receiptLayout, receiptPrintRefusal, receiptSignInEmail, type LayoutSwap } from './receipt-layout';
import { receiptEmail, receiptSms } from './receipt-templates';
import type { ReceiptView } from './receipt.service';
import { ReceiptService } from './receipt.service';
import { PrintRecipeService } from './printing/print-recipe.service';
import { LabelRendererService } from './printing/label-renderer.service';
import { printTarget } from './printing/geometry';

/**
 * Receipt settings per swap (Plan 36): what a receipt is, what it links to,
 * whether and on what it prints, and its fine print.
 */

const settings = (over: Partial<ReceiptSettings> = {}): ReceiptSettings => ({
  receiptMode: 'ITEMIZED', receiptShowSku: true, receiptShowName: true, receiptShowPrice: true,
  receiptLink: 'NONE', receiptPrintEnabled: true, receiptPaperSize: '62x100',
  receiptFinePrintEnabled: false, receiptFinePrint: null, ...over,
});

const swap = (over: Partial<LayoutSwap> = {}): LayoutSwap => ({
  slug: 'ss26', skuLookupEnabled: true, sellerLookupEnabled: true, sellerLoginEnabled: true,
  ...settings(), ...over,
});

const URLS = {
  sellerSiteUrl: 'https://skiswap.patrolkit.io', appUrl: 'https://patrolkit.io',
  orgSlug: 'bmbwavsp', sellerId: 'seller-1', receiptToken: 'tok123',
};

// ─── Saving ──────────────────────────────────────────────────────────────────

describe('saving receipt settings', () => {
  it('refuses a status-only receipt with nothing to link to', () => {
    expect(() => assertReceiptSettings(settings({ receiptMode: 'STATUS_ONLY' }))).toThrow(/needs a status page/);
    expect(() => assertReceiptSettings(settings({ receiptMode: 'STATUS_ONLY', receiptLink: 'SKU_LOOKUP' }))).not.toThrow();
  });

  it('refuses an itemized receipt that names nothing', () => {
    expect(() => assertReceiptSettings(settings({ receiptShowSku: false, receiptShowName: false }))).toThrow(/SKU or name/);
    expect(() => assertReceiptSettings(settings({ receiptShowSku: false }))).not.toThrow();
  });

  it('refuses fine print turned on with none, or too much', () => {
    expect(() => assertReceiptSettings(settings({ receiptFinePrintEnabled: true, receiptFinePrint: '<p> </p>' }))).toThrow(/Add some fine print/);
    expect(() => assertReceiptSettings(settings({ receiptFinePrintEnabled: true, receiptFinePrint: `<p>${'x'.repeat(2001)}</p>` }))).toThrow(/2,000/);
    expect(() => assertReceiptSettings(settings({ receiptFinePrintEnabled: false, receiptFinePrint: null }))).not.toThrow();
    // No receipt: the fine print is hidden, so it isn't judged.
    expect(() => assertReceiptSettings(settings({ receiptMode: 'NONE', receiptFinePrintEnabled: true, receiptFinePrint: null }))).not.toThrow();
  });
});

describe('fine print', () => {
  it('keeps bold, italic, links and lists', () => {
    const html = '<p><strong>All sales final.</strong> <em>No refunds.</em> <a href="https://bmbwav.org/terms">Terms</a></p><ul><li>One</li></ul><ol><li>Two</li></ol>';
    expect(sanitizeFinePrint(html)).toBe(html);
  });

  it('strips everything else: scripts, styles, attributes and javascript: links', () => {
    const out = sanitizeFinePrint('<script>alert(1)</script><p style="color:red" onclick="x()">Hi <a href="javascript:alert(1)">x</a><img src=x><h1>H</h1></p>');
    expect(out).not.toMatch(/script|style|onclick|javascript|<img|<h1/);
    expect(out).toContain('Hi');
  });

  it('turns b and i into strong and em', () => {
    expect(sanitizeFinePrint('<b>B</b><i>I</i>')).toBe('<strong>B</strong><em>I</em>');
  });
});

// ─── The layout ──────────────────────────────────────────────────────────────

describe('a receipt’s layout', () => {
  it('links to each status page by kind', () => {
    expect(receiptLayout(swap({ receiptLink: 'SKU_LOOKUP' }), URLS).link)
      .toEqual({ kind: 'SKU_LOOKUP', url: 'https://skiswap.patrolkit.io/bmbwavsp/ss26/status' });
    expect(receiptLayout(swap({ receiptLink: 'SELLER_STATUS' }), URLS).link)
      .toEqual({ kind: 'SELLER_STATUS', url: 'https://skiswap.patrolkit.io/s/seller-1' });
    expect(receiptLayout(swap({ receiptLink: 'SELLER_LOGIN' }), URLS).link)
      .toEqual({ kind: 'SELLER_LOGIN', url: 'https://patrolkit.io/app/auth/login?r=tok123' });
  });

  it('shows no link to a status page that has been turned off', () => {
    expect(receiptLayout(swap({ receiptLink: 'SKU_LOOKUP', skuLookupEnabled: false }), URLS).link).toBeNull();
    expect(receiptLayout(swap({ receiptLink: 'SELLER_STATUS', sellerLookupEnabled: false }), URLS).link).toBeNull();
    expect(receiptLayout(swap({ receiptLink: 'SELLER_LOGIN', sellerLoginEnabled: false }), URLS).link).toBeNull();
  });

  it('never puts the seller’s email in a sign-in link', () => {
    expect(receiptLayout(swap({ receiptLink: 'SELLER_LOGIN' }), URLS).link?.url).not.toMatch(/@|email/);
  });

  it('prints on the swap’s paper, or not at all', () => {
    expect(receiptLayout(swap({ receiptPaperSize: '50x30' }), URLS).print).toEqual({ paperSize: '50x30' });
    expect(receiptLayout(swap({ receiptPrintEnabled: false }), URLS).print).toBeNull();
  });

  it('is nothing at all under None', () => {
    const layout = receiptLayout(swap({ receiptMode: 'NONE', receiptLink: 'SKU_LOOKUP', receiptFinePrintEnabled: true, receiptFinePrint: '<p>x</p>' }), URLS);
    expect(layout).toMatchObject({ mode: 'NONE', link: null, print: null, finePrint: null });
  });

  it('carries fine print only while it’s on', () => {
    expect(receiptLayout(swap({ receiptFinePrintEnabled: true, receiptFinePrint: '<p>Terms</p>' }), URLS).finePrint).toBe('<p>Terms</p>');
    expect(receiptLayout(swap({ receiptFinePrintEnabled: false, receiptFinePrint: '<p>Terms</p>' }), URLS).finePrint).toBeNull();
  });
});

describe('whether a receipt may print here', () => {
  const s = { receiptMode: 'ITEMIZED', receiptPrintEnabled: true, receiptPaperSize: '62x100' };
  it('is refused under None, with printing off, and on other paper, saying why', () => {
    expect(receiptPrintRefusal({ ...s, receiptMode: 'NONE' }, '62x100')?.code).toBe('RECEIPTS_OFF');
    expect(receiptPrintRefusal({ ...s, receiptPrintEnabled: false }, '62x100')?.code).toBe('RECEIPT_PRINT_OFF');
    expect(receiptPrintRefusal(s, '50x30')).toEqual({
      code: 'RECEIPT_PAPER', message: 'This swap prints receipts on 62 × 100 mm labels; this printer has 50 × 30.',
    });
  });

  it('is allowed on the swap’s paper, or with no printer to judge yet', () => {
    expect(receiptPrintRefusal(s, '62x100')).toBeNull();
    expect(receiptPrintRefusal(s, null)).toBeNull();
  });
});

// ─── Email and text ──────────────────────────────────────────────────────────

const view = (layoutOver: Partial<ReceiptView['layout']> = {}): ReceiptView => ({
  id: 'r1', token: 'tok123', orgName: 'BMBWAV Ski Patrol', orgLogoUrl: null, logoImageUrl: null, swapTitle: 'Ski Swap 2026',
  sellerName: 'Dana Reyes', payoutLabel: 'Check', totalCents: 4500, itemCount: 1, unpricedCount: 0,
  createdAt: new Date('2026-10-04T13:00:00Z'), timeZone: 'America/New_York', url: 'https://skiswap.patrolkit.io/r/tok123',
  trackUrl: 'https://skiswap.patrolkit.io/s/seller-1', brandMarkUrl: 'https://skiswap.patrolkit.io/logo-mark.png',
  layout: { mode: 'ITEMIZED', show: { sku: true, name: true, price: true }, link: null, print: null, finePrint: null, ...layoutOver },
  lines: [{ name: 'Rossignol Skis', sku: '67169', priceCents: 4500 }],
});

describe('the emailed receipt', () => {
  it('shows each column only while it’s on, and drops the total with the price', () => {
    const noPrice = receiptEmail(view({ show: { sku: true, name: true, price: false } }));
    expect(noPrice).toContain('Rossignol Skis');
    expect(noPrice).not.toContain('$45.00');
    const noSku = receiptEmail(view({ show: { sku: false, name: true, price: true } }));
    expect(noSku).not.toContain('67169');
    const skuOnly = receiptEmail(view({ show: { sku: true, name: false, price: true } }));
    expect(skuOnly).not.toContain('Rossignol Skis');
    expect(skuOnly).toContain('67169');
  });

  it('labels its link by what it opens, and has none without one', () => {
    expect(receiptEmail(view({ link: { kind: 'SKU_LOOKUP', url: 'https://x/status' } }))).toContain('Check an item');
    expect(receiptEmail(view({ link: { kind: 'SELLER_LOGIN', url: 'https://x/login' } }))).toContain('Sign in to see your items');
    expect(receiptEmail(view())).not.toContain('Track your items');
  });

  it('is just the link when it’s status page only', () => {
    const html = receiptEmail(view({ mode: 'STATUS_ONLY', link: { kind: 'SELLER_STATUS', url: 'https://x/s/1' } }));
    expect(html).toContain('checked in');
    expect(html).not.toContain('Rossignol Skis');
    expect(html).toContain('Track your items');
  });

  it('says the status page isn’t available when a status-only link has gone', () => {
    expect(receiptEmail(view({ mode: 'STATUS_ONLY', link: null }))).toContain('isn’t available');
  });

  it('carries the fine print above the foot, styled inline', () => {
    const html = receiptEmail(view({ finePrint: '<p>All sales <strong>final</strong>. <a href="https://bmbwav.org">Terms</a></p>' }));
    expect(html).toContain('<strong>final</strong>');
    expect(html).toContain('<a style="color: #dc2626;" href="https://bmbwav.org">');
    expect(html.indexOf('All sales')).toBeLessThan(html.indexOf('A copy of this receipt lives at'));
  });
});

describe('the texted receipt', () => {
  it('leaves the total out with the price, and keeps the fine print out', () => {
    const sms = receiptSms(view({ show: { sku: true, name: true, price: false }, finePrint: '<p>Terms</p>' }));
    expect(sms).not.toContain('$45.00');
    expect(sms).not.toContain('Terms');
    expect(sms).toContain('/r/tok123');
  });

  it('carries the status link itself when it’s status page only', () => {
    const sms = receiptSms(view({ mode: 'STATUS_ONLY', link: { kind: 'SKU_LOOKUP', url: 'https://skiswap.patrolkit.io/bmbwavsp/ss26/status' } }));
    expect(sms).toContain('checked in');
    expect(sms).toContain('https://skiswap.patrolkit.io/bmbwavsp/ss26/status');
    expect(sms).not.toContain('/r/');
  });
});

// ─── Receipts on and off ─────────────────────────────────────────────────────

describe('a swap that gives no receipts', () => {
  function service(mode: string) {
    const prisma = {
      skiSwap: {
        findFirst: async () => ({ receiptMode: mode }),
        findUniqueOrThrow: async () => ({ ...swap({ receiptMode: mode }), org: { slug: 'bmbwavsp' } }),
      },
      receipt: { findUnique: async () => ({ id: 'r1', token: 'tok', swapId: 'swap-1', sellerId: 'seller-1', revokedAt: null, createdAt: new Date() }) },
      receiptLine: { findMany: async () => [] },
    };
    const config = { get: (_k: string, d: unknown) => d };
    return new ReceiptService(prisma as never, {} as never, {} as never, config as never, {} as never, {} as never);
  }

  it('refuses to make one', async () => {
    await expect(service('NONE').createFor('org-1', 'swap-1', 'seller-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('hides one already handed out', async () => {
    await expect(service('NONE').byToken('tok')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service('ITEMIZED').byToken('tok')).resolves.toMatchObject({ layout: { mode: 'ITEMIZED' } });
  });
});

// ─── Printed receipts ────────────────────────────────────────────────────────

describe('a printed receipt', () => {
  function recipes(over: Partial<LayoutSwap> = {}) {
    const prisma = {
      sellerProfile: {
        findFirst: async () => ({
          id: 'seller-1', businessName: null,
          membership: { user: { firstName: 'Dana', lastName: 'Reyes', email: null, phone: '+18025550100' }, org: { logoUrl: null } },
        }),
      },
      swapItem: { findMany: async () => [{ name: 'Snowboard', sku: '67169', priceCents: 9000 }] },
      skiSwap: { findFirst: async () => ({ ...swap(over), org: { slug: 'bmbwavsp' } }) },
      receipt: { findFirst: async () => ({ token: 'tok' }) },
    };
    return new PrintRecipeService(prisma as never, new LabelRendererService(), { get: () => 'https://skiswap.patrolkit.io' } as never);
  }
  const tall = printTarget('m221', '62x100');
  const compact = printTarget('m110', '50x30');
  const items = { kind: 'receipt_items' as const, sellerId: 'seller-1', swapId: 'swap-1' };
  const header = { kind: 'receipt_header' as const, sellerId: 'seller-1', swapId: 'swap-1' };

  it('prints nothing with printing off, under None, or on other paper', async () => {
    await expect(recipes({ receiptPrintEnabled: false }).resolve('org-1', items, tall)).resolves.toEqual([]);
    await expect(recipes({ receiptMode: 'NONE' }).resolve('org-1', items, tall)).resolves.toEqual([]);
    await expect(recipes({ receiptPaperSize: '50x30' }).resolve('org-1', items, tall)).resolves.toEqual([]);
  });

  it('is one masthead page on 62 × 100 when it’s status page only', async () => {
    const pages = await recipes({ receiptMode: 'STATUS_ONLY', receiptLink: 'SKU_LOOKUP' }).resolve('org-1', items, tall);
    expect(pages).toHaveLength(1);
  });

  it('is its header label alone on 50 × 30 when it’s status page only', async () => {
    const r = recipes({ receiptMode: 'STATUS_ONLY', receiptLink: 'SKU_LOOKUP', receiptPaperSize: '50x30' });
    await expect(r.resolve('org-1', items, compact)).resolves.toEqual([]);
    await expect(r.resolve('org-1', header, compact)).resolves.toHaveLength(1);
  });
});

// ─── Signing in from a receipt ───────────────────────────────────────────────

describe('a receipt’s sign-in link', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    revokedAt: null,
    swap: { receiptMode: 'ITEMIZED', receiptLink: 'SELLER_LOGIN', sellerLoginEnabled: true },
    seller: { membership: { user: { verifiedEmail: 'dana@example.com' } } },
    ...over,
  });

  it('goes to the seller’s verified email, and only when the swap links there', () => {
    expect(receiptSignInEmail(row())).toBe('dana@example.com');
    expect(receiptSignInEmail(row({ revokedAt: new Date() }))).toBeNull();
    expect(receiptSignInEmail(row({ swap: { receiptMode: 'ITEMIZED', receiptLink: 'SELLER_STATUS', sellerLoginEnabled: true } }))).toBeNull();
    expect(receiptSignInEmail(row({ swap: { receiptMode: 'ITEMIZED', receiptLink: 'SELLER_LOGIN', sellerLoginEnabled: false } }))).toBeNull();
    expect(receiptSignInEmail(row({ seller: { membership: { user: { verifiedEmail: null } } } }))).toBeNull();
    expect(receiptSignInEmail(null)).toBeNull();
  });

  it('shows the address masked', () => {
    expect(emailHint('dana@example.com')).toBe('d•••@example.com');
  });
});
