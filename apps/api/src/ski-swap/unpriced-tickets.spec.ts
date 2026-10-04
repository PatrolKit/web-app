import { BadRequestException } from '@nestjs/common';
import { ItemService } from './item.service';
import { variationPricing } from './pos/square.pos.adapter';
import { buildRun, type RunItem, type RunSeller } from './payouts/build-run';
import type { PosSaleLine } from './pos/pos.adapter';
import { receiptEmail, receiptSms } from './receipt-templates';
import type { ReceiptView } from './receipt.service';
import { helperPrice, receiptLinePrice } from './printing/label-templates';

/**
 * A legacy ticket may be checked in before it has a price (Plan 32). Staff
 * price it before sales start; one sold first is rung up at a price the clerk
 * types, and the seller is paid on that.
 */

// ─── Creating ────────────────────────────────────────────────────────────────

function harness(nextSku = 'SS26-A-0001') {
  const stored: { sku: string; priceCents: number | null }[] = [];
  let last: object | null = null;
  const prisma = {
    skiSwap: { findFirst: async () => ({ id: 'swap-1', orgId: 'org-1', title: 'Swap', squareCategoryId: 'cat', locationId: 'loc' }) },
    checkinStation: { findFirst: async () => ({ id: 'station-1', code: 'A', bridgeDeviceId: null }) },
    swapItem: {
      create: async ({ data }: { data: { sku: string; priceCents: number | null } }) => {
        stored.push({ sku: data.sku, priceCents: data.priceCents });
        return last = {
          id: 'item-1', sku: data.sku, sellerId: null, orgId: 'org-1', swapId: 'swap-1', name: '', description: null,
          priceCents: data.priceCents, originalQuantity: 1, squareItemId: null, squareVariationId: null,
          donateProceeds: false, hasPrintedTag: false, consignedAt: new Date(), consignedBy: null, updatedAt: new Date(),
          seller: null, photos: [],
        };
      },
      findFirst: async () => null,
      findUnique: async () => null,
      findFirstOrThrow: async () => last,
    },
  };
  const service = new ItemService(
    prisma as never,
    { forOrg: async () => null } as never,
    { findOrThrow: async () => ({ id: 'seller-1' }) } as never,
    {} as never,
    { getCached: async () => null, save: async () => {} } as never,
    { next: async () => nextSku } as never,
    { enqueueItemTags: async () => {} } as never,
    { get: async () => ({ labelsPerItem: 1, requireConsignmentScan: false }) } as never,
    { holderOf: async () => null } as never,
    { describeItems: async () => new Map() } as never,
  );
  (service as unknown as { syncItemToPos: () => Promise<string> }).syncItemToPos = async () => 'skipped';
  return { service, stored };
}

const ITEM = { fallbackName: 'Volkl Kendo 88 skis', quantity: 1 };

describe('checking in an item with no price', () => {
  it('is allowed for a legacy ticket, and stored as no price, not $0', async () => {
    const { service, stored } = harness();
    await service.create('org-1', 'swap-1', { ...ITEM, sku: '67169' });
    await service.create('org-1', 'swap-1', { ...ITEM, sku: '67170', priceCents: null });
    expect(stored).toEqual([{ sku: '67169', priceCents: null }, { sku: '67170', priceCents: null }]);
  });

  it('is refused for an item with a generated SKU', async () => {
    const { service, stored } = harness();
    await expect(service.create('org-1', 'swap-1', ITEM)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create('org-1', 'swap-1', ITEM)).rejects.toThrow(/Only a legacy ticket/);
    expect(stored).toEqual([]);
  });

  it('is refused for a typed SKU that isn’t a ticket number', async () => {
    const { service } = harness();
    await expect(service.create('org-1', 'swap-1', { ...ITEM, sku: 'SHOP-12' })).rejects.toThrow(/Only a legacy ticket/);
  });

  it('keeps a ticket’s price when it has one', async () => {
    const { service, stored } = harness();
    await service.create('org-1', 'swap-1', { ...ITEM, sku: '67169', priceCents: 4500 });
    expect(stored).toEqual([{ sku: '67169', priceCents: 4500 }]);
  });
});

// ─── Square ──────────────────────────────────────────────────────────────────

describe('an unpriced ticket in Square', () => {
  it('is variable-priced with no amount, so the register asks for one', () => {
    expect(variationPricing(null)).toEqual({ pricingType: 'VARIABLE_PRICING' });
  });

  it('turns fixed-priced once it has a price', () => {
    expect(variationPricing(4500)).toEqual({
      pricingType: 'FIXED_PRICING', priceMoney: { amount: BigInt(4500), currency: 'USD' },
    });
  });
});

// ─── Payouts ─────────────────────────────────────────────────────────────────

const SOLD_AT = new Date('2026-10-18T12:00:00Z');
const ticket = (over: Partial<RunItem> = {}): RunItem => ({
  id: 'i1', name: 'Skis', sku: '67169', priceCents: null,
  squareVariationId: 'v1', donateProceeds: false, sellerId: 's1', ...over,
});
const seller: RunSeller = {
  sellerId: 's1', name: 'Dana Reyes', method: 'CHECK', target: null,
  handle: null, handleScanned: false, verifiedEmail: null, verifiedPhone: null,
};
const sale = (over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId: 'o1', variationId: 'v1', quantity: 1, collectedCents: 4000, unitPriceCents: 4000,
  refundedQuantity: 0, soldAt: SOLD_AT, ...over,
});
const opts = { commissionBasisPoints: 2000 };

describe('paying for a ticket sold before it was priced', () => {
  it('owes what the clerk typed, and records it as the ticket’s price', () => {
    const run = buildRun([ticket()], [seller], [sale()], opts);
    expect(run.lines[0]).toMatchObject({ grossCents: 4000, commissionCents: 800, netCents: 3200 });
    expect(run.lines[0].items[0].priceCents).toBe(4000);
    expect(run.pricesFromRegister).toEqual([{ itemId: 'i1', priceCents: 4000 }]);
    expect(run.unpricedSales).toEqual([]);
  });

  it('owes a price staff entered over a typed one', () => {
    const run = buildRun([ticket({ priceCents: 5000 })], [seller], [sale({ unitPriceCents: 4000 })], opts);
    expect(run.lines[0].grossCents).toBe(5000);
    expect(run.pricesFromRegister).toEqual([]);
  });

  it('owes each sale its own typed price, and records none when they differ', () => {
    const run = buildRun(
      [ticket()], [seller],
      [sale({ orderId: 'o1', unitPriceCents: 4000 }), sale({ orderId: 'o2', unitPriceCents: 3000, collectedCents: 3000 })],
      opts,
    );
    expect(run.lines[0].grossCents).toBe(7000);
    expect(run.pricesFromRegister).toEqual([]);
  });

  it('owes on the typed price before a discount, which the discount report then shows', () => {
    const run = buildRun([ticket()], [seller], [sale({ unitPriceCents: 4000, collectedCents: 3000 })], opts);
    expect(run.lines[0].grossCents).toBe(4000);
    expect(run.lines[0].items[0].collectedCents).toBe(3000);
  });

  it('owes nothing, and builds no line, when Square didn’t report the typed price', () => {
    const run = buildRun([ticket()], [seller], [sale({ unitPriceCents: null })], opts);
    expect(run.lines).toEqual([]);
    expect(run.unpricedSales).toEqual([{ itemId: 'i1', sku: '67169', orderId: 'o1' }]);
  });

  it('records no price for a sale that was refunded', () => {
    const run = buildRun([ticket()], [seller], [sale({ refundedQuantity: 1 })], opts);
    expect(run.lines).toEqual([]);
    expect(run.pricesFromRegister).toEqual([]);
  });
});

// ─── Receipts and labels ─────────────────────────────────────────────────────

const view = (over: Partial<ReceiptView> = {}): ReceiptView => ({
  id: 'r1', token: 't', orgName: 'Stowe Patrol', orgLogoUrl: null, logoImageUrl: null, swapTitle: 'Fall Swap',
  sellerName: 'Dana Reyes', payoutLabel: 'Check', totalCents: 4500, itemCount: 2, unpricedCount: 1,
  createdAt: new Date('2026-09-17T13:42:00Z'), timeZone: 'America/New_York', url: 'https://skiswap.patrolkit.io/r/t',
  trackUrl: 'https://skiswap.patrolkit.io/s/s1', brandMarkUrl: 'https://skiswap.patrolkit.io/logo-mark.png',
  layout: { mode: 'ITEMIZED', show: { sku: true, name: true, price: true }, link: { url: 'https://skiswap.patrolkit.io/s/seller123', kind: 'SELLER_STATUS' }, print: { paperSize: '62x100' }, finePrint: null },
  lines: [
    { name: 'Boots', sku: '67169', priceCents: 4500 },
    { name: 'Skis', sku: '67170', priceCents: null },
  ],
  ...over,
});

describe('a receipt with a ticket not yet priced', () => {
  it('says the price is to come rather than $0, and totals the priced items', () => {
    const html = receiptEmail(view());
    expect(html).toContain('Price to come');
    expect(html).not.toContain('$0.00');
    expect(html).toContain('Total of priced items');
    expect(html).toContain('$45.00');
    expect(html).toContain('1 with price to come');
  });

  it('says so in the text, too', () => {
    expect(receiptSms(view())).toContain('$45.00, 1 not yet priced');
  });

  it('reads as before when everything is priced', () => {
    const html = receiptEmail(view({ unpricedCount: 0, lines: [{ name: 'Boots', sku: '67169', priceCents: 4500 }], itemCount: 1 }));
    expect(html).not.toContain('Total of priced items');
    expect(html).not.toContain('Price to come');
  });
});

describe('labels for a ticket not yet priced', () => {
  it('leave a blank for the price on the helper sticker', () => {
    expect(helperPrice(null)).toBe('$____');
    expect(helperPrice(4500)).toBe('$45');
  });

  it('print TBD on a receipt line', () => {
    expect(receiptLinePrice(null)).toBe('TBD');
    expect(receiptLinePrice(4500)).toBe('$45.00');
  });
});
