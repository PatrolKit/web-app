import { defer, lastValueFrom, of } from 'rxjs';
import { ItemService } from './item.service';
import { DeviceStockInterceptor, deviceRequest, servingDevice } from './device-stock.interceptor';
import { parseItemListView } from './item-list-order';

/**
 * The Items page at 10,000 items (Plan 39): the server filters, sorts and
 * pages; Square is read for the page shown, and never for a device.
 */

function row(sku: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${sku}`, sku, name: `Item #${sku}`, priceCents: 1000, hasPrintedTag: true, sellerId: null,
    orgId: 'org-1', swapId: 'swap-1', description: null, originalQuantity: 1, squareItemId: `sq-${sku}`,
    squareVariationId: `var-${sku}`, donateProceeds: false, consignedAt: new Date(), updatedAt: new Date(),
    seller: null, photos: [], ...over,
  };
}

function harness(rows: ReturnType<typeof row>[]) {
  const wheres: unknown[] = [];
  const squareReads: string[][] = [];
  const prisma = {
    skiSwap: { findFirst: async () => ({ id: 'swap-1', orgId: 'org-1', locationId: 'loc-1' }) },
    swapItem: {
      findMany: async (args: { where: { id?: { in: string[] } }; select?: unknown; skip?: number; take?: number }) => {
        wheres.push(args.where);
        if (args.where.id?.in) return rows.filter((r) => args.where.id!.in.includes(r.id)).reverse();
        const all = args.select ? rows : rows.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? 50));
        return all;
      },
      count: async () => rows.length,
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  const pos = {
    getInventoryCounts: async (ids: string[]) => {
      squareReads.push(ids);
      return new Map(ids.map((id) => [id, 1]));
    },
  };
  const service = new ItemService(
    prisma as never, { forOrg: async () => pos } as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, { describeItems: async () => new Map() } as never,
  );
  return { service, wheres, squareReads };
}

describe('the Items list (Plan 39)', () => {
  const rows = [row('100'), row('9'), row('67000'), row('8', { priceCents: null })];

  it('sorts every match, cuts the page, and reads Square for that page only', async () => {
    const { service, squareReads } = harness(rows);
    const res = await service.list('org-1', 'swap-1', { sort: 'sku', dir: 'asc', skip: 1, take: 2 });
    expect(res.items.map((i) => i.sku)).toEqual(['9', '100']);
    expect(res.total).toBe(4);
    expect(squareReads).toEqual([['var-9', 'var-100']]);
  });

  it('turns each status into a condition on our own row', async () => {
    const { service, wheres } = harness(rows);
    await service.list('org-1', 'swap-1', { status: 'not_in_square' });
    await service.list('org-1', 'swap-1', { status: 'needs_price', printed: false });
    await service.list('org-1', 'swap-1', { status: 'not_received' });
    // Missing either id (Plan 41 D14), as the row's badge reads it.
    expect(wheres[0]).toMatchObject({ consignedAt: { not: null } });
    expect((wheres[0] as { AND: unknown[] }).AND).toContainEqual({ OR: [{ squareItemId: null }, { squareVariationId: null }] });
    expect(wheres[1]).toMatchObject({ priceCents: null, hasPrintedTag: false });
    expect(wheres[2]).toMatchObject({ consignedAt: null });
  });

  it('reads no Square for a device', async () => {
    const { service, squareReads } = harness(rows);
    await deviceRequest.run(true, () => service.list('org-1', 'swap-1', { walk: true }));
    expect(squareReads).toEqual([]);
  });

  it('still decides from Square for a device: soldAmong reads it', async () => {
    const { service, squareReads } = harness(rows);
    await deviceRequest.run(true, () => service.soldAmong('org-1', 'swap-1', ['id-9']));
    expect(squareReads.length).toBe(1);
  });

  it('checks the query string', () => {
    expect(parseItemListView({ status: 'needs_price', sort: 'price', dir: 'desc', printed: 'true' }))
      .toEqual({ status: 'needs_price', sort: 'price', dir: 'desc', printed: true });
    expect(parseItemListView({ sort: 'sku' })).toEqual({ sort: 'sku', dir: 'asc' });
    expect(() => parseItemListView({ status: 'sold' })).toThrow(/status must be one of/);
    expect(() => parseItemListView({ sort: 'status' })).toThrow(/sort must be one of/);
  });
});

describe('item responses to a device (Plan 39 D8)', () => {
  const item = { id: 'i', sku: '1', inStock: 1, soldCount: 0, inventoryKnown: true, squareSynced: true };
  const run = (device: boolean, body: unknown) => {
    const ctx = { switchToHttp: () => ({ getRequest: () => (device ? { device: { deviceId: 'd' } } : {}) }) };
    return lastValueFrom(new DeviceStockInterceptor().intercept(ctx as never, { handle: () => of(body) }));
  };

  it('leave out the stock fields, in a list and on one item', async () => {
    expect(await run(true, { items: [item], total: 1 })).toEqual({ items: [{ id: 'i', sku: '1', squareSynced: true }], total: 1 });
    expect(await run(true, item)).toEqual({ id: 'i', sku: '1', squareSynced: true });
  });

  it('run the handler as a device’s request, even across awaits', async () => {
    const ctx = (device: boolean) => ({ switchToHttp: () => ({ getRequest: () => (device ? { device: {} } : {}) }) });
    const handler = { handle: () => defer(async () => { await new Promise((r) => setTimeout(r, 1)); return servingDevice(); }) };
    expect(await lastValueFrom(new DeviceStockInterceptor().intercept(ctx(true) as never, handler))).toBe(true);
    expect(await lastValueFrom(new DeviceStockInterceptor().intercept(ctx(false) as never, handler))).toBe(false);
  });

  it('are unchanged for a person', async () => {
    expect(await run(false, item)).toEqual(item);
  });
});

describe('the Receipt popup’s figures (Plan 39 D7)', () => {
  it('count a seller’s items and their listed value, with no Square read', async () => {
    const reads: unknown[] = [];
    const prisma = {
      skiSwap: { findFirst: async () => ({ id: 'swap-1', locationId: 'loc-1' }) },
      swapItem: {
        findMany: async () => [
          { priceCents: 4500, originalQuantity: 1 },
          { priceCents: 1000, originalQuantity: 3 },
          { priceCents: null, originalQuantity: 1 },
        ],
      },
    };
    const service = new ItemService(
      prisma as never, { forOrg: async () => { reads.push(1); return null; } } as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    );
    expect(await service.sellerSummary('org-1', 'swap-1', 'seller-1')).toEqual({ items: 3, listedValueCents: 7500, unpriced: 1 });
    expect(reads).toEqual([]);
  });
});
