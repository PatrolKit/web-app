import { ConflictException, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { PERMISSIONS_KEY } from '../common/decorators/require-permissions.decorator';
import { ExchangesController } from './exchanges.controller';
import { applyExchanges, attributeSales, classify, type CheckItem } from './sales-check';
import { ExchangesService } from './exchanges.service';
import { ItemBreakdownService, soldByVariation } from './item-breakdown.service';
import { buildRun, discountsOf, exchangedKeyOf, type RunItem, type RunSeller } from './payouts/build-run';
import type { PosSaleLine } from './pos/pos.adapter';

/**
 * Exchanges (Plan 49), from the case that drove them: Little Mountain's 87344
 * (poles, $19) sold on receipt #Gq00, in a six-item sale, and came back for
 * 87339, a different size at the same price.
 */

const SOLD_AT = new Date('2026-10-09T15:00:00Z');
const line = (over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId: 'order-gq00', lineUid: 'l1', variationId: 'v-87344', paymentId: 'Gq00QHSWxk6mYucPNOUSlXKbGMYZY',
  quantity: 1, collectedCents: 1900, unitPriceCents: 1900, refundedQuantity: 0, soldAt: SOLD_AT, ...over,
});
/** Gq00: 87344 and five other items. */
const GQ00 = [
  line(),
  ...[2, 3, 4, 5, 6].map((n) => line({ lineUid: `l${n}`, variationId: `v-other-${n}`, collectedCents: 1000, unitPriceCents: 1000 })),
];

const checkItem = (sku: string, over: Partial<CheckItem> = {}): CheckItem => ({
  id: `item-${sku}`, sku, name: 'Leki poles', priceCents: 1900, sellerName: 'Little Mountain', sellerId: 'seller-lm',
  squareVariationId: `v-${sku}`, originalQuantity: 1, deleted: false, ...over,
});
const ITEMS = [checkItem('87344'), checkItem('87339'), checkItem('87341'),
  ...[2, 3, 4, 5, 6].map((n) => checkItem(`7000${n}`, { squareVariationId: `v-other-${n}` }))];
const variationOfItem = new Map(ITEMS.map((i) => [i.id, i.squareVariationId!]));
const ours = new Set(ITEMS.map((i) => i.squareVariationId!));
const EX = { orderId: 'order-gq00', lineUid: 'l1', replacementItemId: 'item-87339' };

describe('applyExchanges', () => {
  it('moves the exchanged line onto the item that went out, and leaves the rest of the receipt alone', () => {
    const out = applyExchanges(GQ00, [EX], variationOfItem);
    expect(out[0].variationId).toBe('v-87339');
    expect(out.slice(1)).toEqual(GQ00.slice(1));
    expect(applyExchanges(GQ00, [], variationOfItem)).toBe(GQ00);
  });

  it('runs after Sales check: a line credited to 87344 and then exchanged counts for 87339', () => {
    const lines = [line({ variationId: 'v-last-year' })];
    const credited = attributeSales(lines, [{ orderId: 'order-gq00', lineUid: 'l1', decision: 'CREDIT', itemId: 'item-87344' }], [], ours, variationOfItem);
    expect(credited[0].variationId).toBe('v-87344');
    const exchanged = attributeSales(lines, [{ orderId: 'order-gq00', lineUid: 'l1', decision: 'CREDIT', itemId: 'item-87344' }], [EX], ours, variationOfItem);
    expect(exchanged[0].variationId).toBe('v-87339');
  });
});

describe('every reader, after 87344 → 87339', () => {
  it('dashboard and Catalog check: 87339 sold, 87344 not', () => {
    const sold = soldByVariation(attributeSales(GQ00, [], [EX], ours, variationOfItem));
    expect(sold.get('v-87339')).toBe(1);
    expect(sold.get('v-87344')).toBeUndefined();
  });

  it('payouts: Little Mountain is paid $19 for 87339, not 87344', () => {
    const runItems: RunItem[] = ITEMS.map((i) => ({
      id: i.id, name: i.name, sku: i.sku, priceCents: i.priceCents, squareVariationId: i.squareVariationId,
      donateProceeds: false, sellerId: i.sellerId, originalQuantity: 1,
    }));
    const seller: RunSeller = {
      sellerId: 'seller-lm', name: 'Little Mountain', method: 'CHECK', target: 'EMAIL',
      handle: null, handleScanned: false, verifiedEmail: null, verifiedPhone: null,
    };
    const { lines } = buildRun(runItems, [seller], attributeSales([GQ00[0]], [], [EX], ours, variationOfItem), { commissionBasisPoints: 0 });
    expect(lines[0].items.map((i) => [i.sku, i.priceCents])).toEqual([['87339', 1900]]);
  });

  it('Sales check: nothing to check, even after the register sells 87344 again', () => {
    const input = { items: ITEMS, decisions: [], described: new Map(), categoryNames: new Map(), ignoredCategoryIds: new Set<string>() };
    expect(classify({ ...input, lines: GQ00, exchanges: [EX] })).toEqual([]);
    const resold = [...GQ00, line({ orderId: 'order-later', lineUid: 'm1', paymentId: 'Zz11later' })];
    expect(classify({ ...input, lines: resold, exchanges: [EX] })).toEqual([]);
    // Without the exchange, that second sale of 87344 is a ticket sold twice.
    expect(classify({ ...input, lines: resold }).map((i) => i.kind)).toEqual(['oversold']);
  });
});

describe('the discount report', () => {
  it('labels an exchange for a higher-priced item, and leaves it out of the total', () => {
    const lines = [{ sellerName: 'Little Mountain', items: [
      { itemId: 'item-87339', name: 'Poles', sku: '87339', priceCents: 2500, quantity: 1, collectedCents: 1900, squareOrderId: 'order-gq00' },
      { itemId: 'item-70002', name: 'Helmet', sku: '70002', priceCents: 1000, quantity: 1, collectedCents: 800, squareOrderId: 'order-gq00' },
    ] }];
    const { discounts, totalGapCents } = discountsOf(lines, new Set([exchangedKeyOf('item-87339', 'order-gq00')]));
    expect(discounts.map((d) => [d.sku, d.exchange])).toEqual([['87339', true], ['70002', false]]);
    expect(totalGapCents).toBe(200);
  });
});

// ─── The service, against an in-memory store ──────────────────────────────────

interface Row { [k: string]: unknown; id: string; liveKey: string | null }

function harness(opts: {
  lines?: PosSaleLine[]; items?: Partial<ReturnType<typeof dbItem>>[]; stock?: Record<string, number>;
  failStockWrites?: number; paidRun?: boolean;
} = {}) {
  const items = (opts.items ?? [{}, { id: 'item-87339', sku: '87339', squareVariationId: 'v-87339' }, { id: 'item-87341', sku: '87341', squareVariationId: 'v-87341' }])
    .map((o) => dbItem(o));
  const stock = new Map(Object.entries(opts.stock ?? { 'v-87344': 0, 'v-87339': 1, 'v-87341': 1 }));
  let failWrites = opts.failStockWrites ?? 0;
  const exchanges: Row[] = [];
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const patches: { itemId: string; priceCents: number }[] = [];
  let sales = opts.lines ?? GQ00;
  let n = 0;

  const matches = (r: Row, where: Record<string, unknown>) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in (v as object)) return r[k] !== (v as { not: unknown }).not;
    return r[k] === v;
  });
  const unique = (r: Row) => {
    if (r.liveKey && exchanges.some((x) => x !== r && x.liveKey === r.liveKey)) {
      throw Object.assign(new (jest.requireActual('@prisma/client').Prisma.PrismaClientKnownRequestError)('dup', { code: 'P2002', clientVersion: 'x' }));
    }
  };
  const swapExchange = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => exchanges.filter((r) => matches(r, where)).sort((a, b) => (b.recordedAt as Date).getTime() - (a.recordedAt as Date).getTime()),
    findFirst: async ({ where }: { where: Record<string, unknown> }) => exchanges.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: { id: string } }) => exchanges.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const r = { cancelledAt: null, cancelledBy: null, cancelReason: null, liveKey: null, recordedAt: new Date(Date.now() + n), ...data, id: `ex-${++n}` } as Row;
      exchanges.push(r);
      try { unique(r); } catch (err) { exchanges.pop(); throw err; }
      return r;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = exchanges.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      unique(r);
      return r;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = exchanges.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    },
  };
  const prisma = {
    skiSwap: { findFirst: async () => ({ id: 'swap', locationId: 'loc' }) },
    swapItem: { findMany: async ({ where }: { where: { id?: { in: string[] } } }) => items.filter((i) => !where.id || where.id.in.includes(i.id)) },
    swapSaleDecision: { findMany: async () => [] },
    squareConfig: { findUnique: async () => ({ environment: 'production' }) },
    user: { findMany: async () => [{ id: 'admin', firstName: 'Pat', lastName: 'Admin', email: null }] },
    auditLog: { create: async ({ data }: { data: { action: string; metadata: Record<string, unknown> } }) => { audits.push(data); } },
    payoutLineItem: {
      findMany: async () => (opts.paidRun ? [{ itemId: 'item-87344', squareOrderId: 'order-gq00', line: { run: { id: 'run-1', status: 'CLOSED' } } }] : []),
    },
    swapExchange,
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(prisma),
  };
  const pos = {
    getInventoryCounts: async (ids: string[]) => new Map(ids.map((id) => [id, stock.get(id) ?? 0])),
    setInventoryPhysicalCount: async (id: string, _loc: string, q: number) => {
      if (failWrites > 0) { failWrites--; throw new Error('Square said no'); }
      stock.set(id, q);
    },
  };
  const breakdown = { forgetSales: () => {}, rawSales: async () => ({ at: Date.now(), lines: sales }) };
  const itemService = {
    patch: async (_o: string, _s: string, itemId: string, data: { priceCents: number }) => {
      patches.push({ itemId, priceCents: data.priceCents });
      items.find((i) => i.id === itemId)!.priceCents = data.priceCents;
    },
  };
  const memo = new Map<string, unknown>();
  const idempotency = { getCached: async (s: string, k: string) => memo.get(`${s}|${k}`) ?? null, save: async (s: string, k: string, v: unknown) => { memo.set(`${s}|${k}`, v); } };
  const service = new ExchangesService(prisma as never, { forOrg: async () => pos } as never, breakdown as never, idempotency as never, itemService as never);
  return { service, stock, exchanges, audits, patches, setSales: (l: PosSaleLine[]) => { sales = l; } };
}

function dbItem(over: Record<string, unknown> = {}) {
  return {
    id: 'item-87344', sku: '87344', name: 'Leki poles', priceCents: 1900 as number | null, squareVariationId: 'v-87344', originalQuantity: 1,
    deletedAt: null, returnedAt: null, seller: { id: 'seller-lm', businessName: 'Little Mountain', membership: { user: { firstName: 'Lee', lastName: 'Mountain', email: null } } },
    ...over,
  };
}

const RECORD = { orderId: 'order-gq00', lineUid: 'l1', returnedItemId: 'item-87344', replacementItemId: 'item-87339' };

describe('ExchangesService', () => {
  it('finds Gq00 by receipt or by the ticket coming back, one line of six', async () => {
    const { service } = harness();
    const byReceipt = await service.lookup('org', 'swap', { receipt: '#gq00' });
    expect(byReceipt.lines.map((l) => l.item.sku)).toEqual(['87344']);
    expect(byReceipt.lines[0]).toMatchObject({ receipt: 'Gq00', exchange: null, paidInRun: null });
    const byTicket = await service.lookup('org', 'swap', { ticket: '87344' });
    expect(byTicket.lines.map((l) => l.orderId)).toEqual(['order-gq00']);
  });

  it('records 87344 → 87339: stock moves one each way, and it is audited', async () => {
    const { service, stock, audits } = harness();
    const r = await service.record('org', 'swap', RECORD, 'admin');
    expect(r.stockError).toBeNull();
    expect(r.exchange).toMatchObject({ status: 'live', receipt: 'Gq00', differenceCents: 0, stockSynced: true, recordedByName: 'Pat Admin' });
    expect([stock.get('v-87344'), stock.get('v-87339')]).toEqual([1, 0]);
    expect(audits.map((a) => a.action)).toEqual(['ski_swap.exchange.recorded']);
    // Now 87339 is the one that sold: looking up the receipt finds it, exchanged.
    const again = await service.lookup('org', 'swap', { receipt: 'Gq00' });
    expect(again.lines[0]).toMatchObject({ item: { sku: '87339' }, exchange: { returnedSku: '87344' } });
  });

  it('is idempotent', async () => {
    const { service, exchanges, stock } = harness();
    const a = await service.record('org', 'swap', RECORD, 'admin', 'key-1');
    const b = await service.record('org', 'swap', RECORD, 'admin', 'key-1');
    expect(b).toEqual(a);
    expect(exchanges).toHaveLength(1);
    expect(stock.get('v-87339')).toBe(0);
  });

  it('refuses an item going out that isn’t for sale, and a line that moved since the lookup', async () => {
    const sold = harness({ stock: { 'v-87344': 0, 'v-87339': 0 } });
    await expect(sold.service.record('org', 'swap', RECORD, 'admin')).rejects.toThrow('Square has 87339 out of stock');
    const soldInSales = harness({ lines: [...GQ00, line({ orderId: 'o2', lineUid: 'x', variationId: 'v-87339', paymentId: 'Ab12' })] });
    await expect(soldInSales.service.record('org', 'swap', RECORD, 'admin')).rejects.toThrow('87339 is sold already');
    const moved = harness();
    await moved.service.record('org', 'swap', RECORD, 'admin');
    await expect(moved.service.record('org', 'swap', { ...RECORD, replacementItemId: 'item-87341' }, 'admin'))
      .rejects.toThrow('That sale isn’t counted on 87344 any more');
  });

  it('prices an unpriced item going out, and won’t record one without a price', async () => {
    const h = harness({ items: [{}, { id: 'item-87339', sku: '87339', squareVariationId: 'v-87339', priceCents: null }] });
    await expect(h.service.record('org', 'swap', RECORD, 'admin')).rejects.toThrow('87339 has no price yet');
    const r = await h.service.record('org', 'swap', { ...RECORD, priceCents: 2500 }, 'admin');
    expect(h.patches).toEqual([{ itemId: 'item-87339', priceCents: 2500 }]);
    expect(r).toMatchObject({ pricedCents: 2500, exchange: { replacementPriceCents: 2500, differenceCents: 600 } });
  });

  it('keeps the exchange when Square’s stock can’t be written, and Retry settles it', async () => {
    const h = harness({ failStockWrites: 1 });
    const r = await h.service.record('org', 'swap', RECORD, 'admin');
    expect(r.stockError).toBe('Square said no');
    expect(r.exchange.stockSynced).toBe(false);
    const retried = await h.service.retryStock('org', 'swap', r.exchange.id, 'admin');
    expect(retried.stockSynced).toBe(true);
    expect([h.stock.get('v-87344'), h.stock.get('v-87339')]).toEqual([1, 0]);
  });

  it('cancelling puts stock back, keeps the record, and is refused once 87344 sold again', async () => {
    const h = harness();
    const { exchange } = await h.service.record('org', 'swap', RECORD, 'admin');
    const cancelled = await h.service.cancel('org', 'swap', exchange.id, 'Wrong poles', 'admin');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelReason: 'Wrong poles' });
    expect([h.stock.get('v-87344'), h.stock.get('v-87339')]).toEqual([0, 1]);

    const resold = harness();
    const r = await resold.service.record('org', 'swap', RECORD, 'admin');
    resold.setSales([...GQ00, line({ orderId: 'o2', lineUid: 'x', paymentId: 'Ab12' })]);
    await expect(resold.service.cancel('org', 'swap', r.exchange.id, 'oops', 'admin')).rejects.toThrow(ConflictException);
    await expect(resold.service.cancel('org', 'swap', r.exchange.id, 'oops', 'admin')).rejects.toThrow('would put two on the floor');
  });

  it('chains: a second exchange supersedes the first; cancelling it brings the first back', async () => {
    const h = harness();
    const first = (await h.service.record('org', 'swap', RECORD, 'admin')).exchange;
    const second = (await h.service.record('org', 'swap', { ...RECORD, returnedItemId: 'item-87339', replacementItemId: 'item-87341' }, 'admin')).exchange;
    expect(second.supersedesId).toBe(first.id);
    let list = await h.service.list('org', 'swap');
    expect(list.exchanges.map((e) => [e.id, e.status])).toEqual([[second.id, 'live'], [first.id, 'superseded']]);
    expect([h.stock.get('v-87344'), h.stock.get('v-87339'), h.stock.get('v-87341')]).toEqual([1, 1, 0]);
    await expect(h.service.cancel('org', 'swap', first.id, 'x', 'admin')).rejects.toThrow('Cancel that one first');

    await h.service.cancel('org', 'swap', second.id, 'Kept the first pair', 'admin');
    list = await h.service.list('org', 'swap');
    expect(list.exchanges.map((e) => e.status)).toEqual(['cancelled', 'live']);
    expect([h.stock.get('v-87344'), h.stock.get('v-87339'), h.stock.get('v-87341')]).toEqual([1, 0, 1]);
  });

  it('totals what the patrol absorbed and kept across live exchanges', async () => {
    const h = harness({ items: [{ priceCents: 2000 }, { id: 'item-87339', sku: '87339', squareVariationId: 'v-87339', priceCents: 3200 }] });
    await h.service.record('org', 'swap', RECORD, 'admin');
    expect((await h.service.list('org', 'swap')).totals).toEqual({ live: 1, absorbedCents: 1200, keptCents: 0 });
  });

  it('warns when a payout run past draft already paid the item coming back', async () => {
    const { service } = harness({ paidRun: true });
    const r = await service.lookup('org', 'swap', { receipt: 'Gq00' });
    expect(r.lines[0].paidInRun).toEqual({ runId: 'run-1', status: 'CLOSED' });
  });
});

describe('the dashboard reads exchanges', () => {
  it('counts the exchanged sale for the item that went out', async () => {
    const pos = { listSales: async () => [line()] };
    const prisma = {
      swapSaleDecision: { findMany: async () => [] },
      swapExchange: { findMany: async () => [EX] },
      skiSwap: { findFirst: async () => ({ id: 'swap', createdAt: new Date('2026-09-01'), locationId: 'loc' }) },
      swapItem: { findMany: async () => [{ id: 'item-87339', squareVariationId: 'v-87339' }] },
    };
    const svc = new ItemBreakdownService(prisma as never, { forOrg: async () => pos } as never);
    const sold = await svc.soldUnits('org', 'swap');
    expect([sold.get('v-87339'), sold.get('v-87344')]).toEqual([1, undefined]);
  });
});

describe('the exchange routes (D1)', () => {
  const reflector = new Reflector();
  const route = (name: keyof ExchangesController) => [
    Reflect.getMetadata(METHOD_METADATA, ExchangesController.prototype[name]),
    reflector.get(PERMISSIONS_KEY, ExchangesController.prototype[name]),
  ];

  it('let anyone who reads reports see the list, and only an admin look up, record, edit, cancel or retry', () => {
    expect(route('list')).toEqual([RequestMethod.GET, ['ski_swap:report']]);
    expect(route('lookup')).toEqual([RequestMethod.GET, ['ski_swap:admin']]);
    expect(route('record')).toEqual([RequestMethod.POST, ['ski_swap:admin']]);
    expect(route('edit')).toEqual([RequestMethod.PATCH, ['ski_swap:admin']]);
    expect(route('cancel')).toEqual([RequestMethod.POST, ['ski_swap:admin']]);
    expect(route('retryStock')).toEqual([RequestMethod.POST, ['ski_swap:admin']]);
  });

  it('reading the list touches no Square and writes nothing', async () => {
    const h = harness();
    await h.service.record('org', 'swap', RECORD, 'admin');
    const before = JSON.stringify([...h.stock]) + JSON.stringify(h.exchanges) + h.audits.length;
    await h.service.list('org', 'swap');
    expect(JSON.stringify([...h.stock]) + JSON.stringify(h.exchanges) + h.audits.length).toBe(before);
  });
});
