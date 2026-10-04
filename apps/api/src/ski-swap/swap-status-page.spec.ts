import { ConflictException, NotFoundException } from '@nestjs/common';
import { SwapService } from './swap.service';
import { deriveSwapSlug } from './sku.util';
import { publicItemStatus } from './public-item-status';
import { PublicStatusService } from './public-status.service';
import { PublicLookupService } from './public-lookup.service';
import { PublicSellerService } from './public-seller.service';

/**
 * Plan 33: a swap's slug, the public SKU lookup, and the seller status pages
 * each swap decides whether to show.
 */

// ─── Slug ────────────────────────────────────────────────────────────────────

type SwapRow = Record<string, unknown> & { id: string; orgId: string; title: string; slug: string };

function swaps(existing: Partial<SwapRow>[] = []) {
  const rows: SwapRow[] = existing.map((r, i) => ({
    id: `swap-${i}`, orgId: 'org-1', title: `Swap ${i}`, slug: `s${i}`, squareCategoryId: 'cat', locationId: 'loc',
    active: false, skuPrefix: 'SS26', activeSkuPrefix: null, allowLegacyCheckin: false, allowLegacyWeb: false, allowPrintCheckin: true, allowPrintWeb: true,
    printLegacyHelperLabels: false, labelsPerItem: 1, skuLookupEnabled: false,
    sellerLookupEnabled: false, sellerLoginEnabled: false, createdAt: new Date(), updatedAt: new Date(), ...r,
  }));
  const matches = (r: SwapRow, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'id' && v && typeof v === 'object' && 'not' in v) return r.id !== (v as { not: string }).not;
      if (v && typeof v === 'object' && 'startsWith' in v) return String(r[k]).startsWith((v as { startsWith: string }).startsWith);
      return r[k] === v;
    });
  const prisma = {
    skiSwap: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null,
      create: async ({ data }: { data: SwapRow }) => {
        const row = { createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  // Enough of Square for a rename: the category is there, and takes the new name.
  const square = {
    catalog: { object: { get: async () => ({ object: { version: BigInt(1) } }), upsert: async () => ({}) } },
  };
  const service = new SwapService(prisma as never, { forOrg: async () => square } as never);
  const internals = service as unknown as Record<string, unknown>;
  internals.findOrCreatePatrolKitCategory = async () => 'parent';
  internals.findOrCreateSwapCategory = async () => 'cat';
  internals.renameSquareCategory = async () => undefined;
  return { service, rows };
}

describe('a swap’s slug', () => {
  it('is the SKU prefix’s derivation, lowercased', () => {
    expect(deriveSwapSlug('Ski Swap 2026')).toBe('ss26');
    expect(deriveSwapSlug('The Fall Sale of 2025')).toBe('fs25');
  });

  it('is derived on create, and made unique with -2, -3', async () => {
    const { service } = swaps([{ slug: 'ss26' }, { slug: 'ss26-2' }]);
    const created = await service.create('org-1', 'Ski Swap 2026', 'loc', 'user-1');
    expect(created.slug).toBe('ss26-3');
  });

  it('takes one someone typed, and refuses one already used', async () => {
    const { service } = swaps([{ slug: 'fall', title: 'Fall Swap' }]);
    await expect(service.create('org-1', 'Ski Swap 2026', 'loc', 'user-1', { slug: 'spring' }))
      .resolves.toMatchObject({ slug: 'spring' });
    await expect(service.create('org-1', 'Another', 'loc', 'user-1', { slug: 'fall' }))
      .rejects.toThrow(/"Fall Swap" already uses the slug "fall"/);
  });

  it('starts every status switch off', async () => {
    const { service } = swaps();
    await expect(service.create('org-1', 'Ski Swap 2026', 'loc', 'user-1')).resolves.toMatchObject({
      skuLookupEnabled: false, sellerLookupEnabled: false, sellerLoginEnabled: false,
    });
  });

  it('stays put when the swap is renamed', async () => {
    const { service, rows } = swaps([{ id: 'swap-a', slug: 'ss26', title: 'Ski Swap 2026' }]);
    await service.patch('org-1', 'swap-a', { title: 'Fall Swap 2027' });
    expect(rows[0].slug).toBe('ss26');
  });

  it('can be changed, but not to another swap’s', async () => {
    const { service } = swaps([{ id: 'swap-a', slug: 'ss26' }, { id: 'swap-b', slug: 'fall', title: 'Fall Swap' }]);
    await expect(service.patch('org-1', 'swap-a', { slug: 'spring' })).resolves.toMatchObject({ slug: 'spring' });
    await expect(service.patch('org-1', 'swap-a', { slug: 'fall' })).rejects.toBeInstanceOf(ConflictException);
  });
});

// ─── What the public is told about one item ──────────────────────────────────

describe('an item’s public status', () => {
  const item = { consignedAt: new Date(), squareVariationId: 'v1', originalQuantity: 1 };
  const inStock = (n: number) => new Map([['v1', n]]);

  it('is not received until it’s consigned', () => {
    expect(publicItemStatus({ ...item, consignedAt: null }, inStock(1)).status).toBe('not_received');
  });

  it('is for sale or sold by Square’s count', () => {
    expect(publicItemStatus(item, inStock(1)).status).toBe('for_sale');
    expect(publicItemStatus(item, inStock(0)).status).toBe('sold');
  });

  it('counts units sold of several', () => {
    expect(publicItemStatus({ ...item, originalQuantity: 3 }, inStock(1))).toEqual({ status: 'for_sale', soldCount: 2, quantity: 3 });
  });

  it('is unknown, not guessed, when Square can’t say', () => {
    expect(publicItemStatus(item, null).status).toBe('unknown');
    expect(publicItemStatus({ ...item, squareVariationId: null }, inStock(1)).status).toBe('unknown');
  });
});

// ─── Unauthenticated SKU Lookup ──────────────────────────────────────────────

function lookup(opts: { enabled?: boolean; item?: object | null; inStock?: number | null } = {}) {
  const item = opts.item === undefined
    ? { sku: '67169', name: 'Rossignol skis', consignedAt: new Date(), squareVariationId: 'v1', originalQuantity: 1 }
    : opts.item;
  const prisma = {
    organization: { findFirst: async () => ({ id: 'org-1', name: 'BMBWAV', logoUrl: null }) },
    orgModule: { findUnique: async () => ({ enabled: true }) },
    skiSwap: {
      findFirst: async ({ where }: { where: { skuLookupEnabled: boolean } }) =>
        (opts.enabled ?? true) && where.skuLookupEnabled ? { id: 'swap-1', title: 'Ski Swap 2026', locationId: 'loc' } : null,
    },
    swapItem: { findFirst: async () => item },
  };
  const pos = {
    getInventoryCounts: async () => {
      if (opts.inStock === null) throw new Error('Square down');
      return new Map([['v1', opts.inStock ?? 1]]);
    },
  };
  return new PublicStatusService(prisma as never, { forOrg: async () => pos } as never);
}

describe('the public SKU lookup', () => {
  it('tells one SKU’s name and status, and nothing else', async () => {
    const result = await lookup().sku('bmbwav', 'ss26', ' 67169 ');
    expect(result).toEqual({ sku: '67169', name: 'Rossignol skis', status: 'for_sale' });
  });

  it('says sold, and says it can’t tell when Square is down', async () => {
    await expect(lookup({ inStock: 0 }).sku('bmbwav', 'ss26', '67169')).resolves.toMatchObject({ status: 'sold' });
    await expect(lookup({ inStock: null }).sku('bmbwav', 'ss26', '67169')).resolves.toMatchObject({ status: 'unknown' });
  });

  it('answers the same 404 for a closed swap and an unknown SKU', async () => {
    const closed = await lookup({ enabled: false }).sku('bmbwav', 'ss26', '67169').catch((e: unknown) => e);
    const missing = await lookup({ item: null }).sku('bmbwav', 'ss26', '99999').catch((e: unknown) => e);
    expect(closed).toBeInstanceOf(NotFoundException);
    expect(missing).toBeInstanceOf(NotFoundException);
    expect((closed as Error).message).toBe((missing as Error).message);
  });

  it('gives the page its title only when the switch is on', async () => {
    await expect(lookup().page('bmbwav', 'ss26')).resolves.toEqual({ orgName: 'BMBWAV', orgLogoUrl: null, swapTitle: 'Ski Swap 2026' });
    await expect(lookup({ enabled: false }).page('bmbwav', 'ss26')).rejects.toBeInstanceOf(NotFoundException);
  });
});

// ─── Unauthenticated Seller Status ───────────────────────────────────────────

describe('the email and last-4 lookup', () => {
  it('only looks among sellers in a swap with the switch on', async () => {
    let where: Record<string, unknown> = {};
    const prisma = {
      organization: { findFirst: async () => ({ id: 'org-1' }) },
      orgModule: { findUnique: async () => ({ enabled: true }) },
      sellerProfile: { findMany: async (args: { where: Record<string, unknown> }) => { where = args.where; return []; } },
    };
    await new PublicLookupService(prisma as never).findByEmailAndLast4('bmbwav', 'dana@example.com', '0142').catch(() => null);
    expect(where.swapItems).toEqual({ some: { deletedAt: null, swap: { active: true, sellerLookupEnabled: true } } });
  });
});

describe('a seller’s /s/ page', () => {
  function page(opts: { openSwaps: number; items: number; payouts?: number }) {
    const prisma = {
      sellerProfile: {
        findUnique: async () => ({
          id: 'seller-1', deletedAt: null, businessName: null,
          membership: { deletedAt: null, orgId: 'org-1', org: { name: 'BMBWAV', logoUrl: null },
            user: { firstName: 'Dana', lastName: 'Reyes', email: null, phone: null, payoutMethod: 'CHECK' } },
        }),
      },
      orgModule: { findUnique: async () => ({ enabled: true }) },
      skiSwap: { findMany: async () => Array.from({ length: opts.openSwaps }, (_, i) => ({ id: `swap-${i}`, title: 'Swap', locationId: '' })) },
      swapItem: { count: async () => opts.items, findMany: async () => [] },
      payoutLine: { findMany: async () => Array.from({ length: opts.payouts ?? 0 }, () => ({
        status: 'SENT', grossCents: 1000, commissionCents: 100, netCents: 900, method: 'CHECK', destination: null,
        destinationType: null, sentAt: null, checkSentAt: null, run: { commissionBasisPoints: 1000, swap: { title: 'Swap' } },
      })) },
    };
    return new PublicSellerService(prisma as never, { forOrg: async () => null } as never).getById('seller-1');
  }

  it('shows nothing, not even the name, when none of their swaps allow it', async () => {
    await expect(page({ openSwaps: 0, items: 0 })).resolves.toMatchObject({
      available: false, sellerName: null, swaps: [], payouts: [],
    });
  });

  it('shows the seller where a swap allows it', async () => {
    await expect(page({ openSwaps: 1, items: 2 })).resolves.toMatchObject({ available: true, sellerName: 'Dana Reyes' });
  });

  it('still shows payouts from a swap that allows it, after the swap has closed', async () => {
    await expect(page({ openSwaps: 0, items: 0, payouts: 1 })).resolves.toMatchObject({ available: true, swaps: [] });
  });
});
