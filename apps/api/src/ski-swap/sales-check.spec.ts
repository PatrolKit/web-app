import { ConflictException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { applyDecisions, classify, ticketNumbersIn, type CheckItem, type ClassifyInput } from './sales-check';
import { buildRun } from './payouts/build-run';
import { SalesCheckService } from './sales-check.service';
import { SalesCheckController } from './sales-check.controller';
import { PERMISSIONS_KEY } from '../common/decorators/require-permissions.decorator';
import type { PosOrderFees, PosSaleLine, PosVariationInfo } from './pos/pos.adapter';

/**
 * Sales check (Plan 48): sales PatrolKit can't put on this swap's items,
 * found and explained by reading only (D13), and fixed only by a person's
 * choice. The examples are 2026-10-09's.
 */

const at = new Date('2026-10-09T18:00:00Z');
const line = (orderId: string, variationId: string, over: Partial<PosSaleLine> = {}): PosSaleLine => ({
  orderId, variationId, lineUid: `${orderId}-u`, quantity: 1, collectedCents: 4000, unitPriceCents: 4000, refundedQuantity: 0, soldAt: at, paymentId: `pay-${orderId}`, ...over,
});
const item = (sku: string, over: Partial<CheckItem> = {}): CheckItem => ({
  id: `it-${sku}`, sku, name: `Item #${sku}`, priceCents: null, sellerName: 'Karen Beckwith', sellerId: 'seller-1', squareVariationId: `v-${sku}`, originalQuantity: 1, deleted: false, ...over,
});
const variation = (id: string, sku: string, itemName: string, over: Partial<PosVariationInfo> = {}): PosVariationInfo => ({
  variationId: id, itemId: `sq-${id}`, itemName, variationName: null, sku, categoryIds: ['cat-2025'], archived: true, ...over,
});

function input(over: Partial<ClassifyInput>): ClassifyInput {
  return { lines: [], items: [], decisions: [], described: new Map(), categoryNames: new Map([['cat-2025', '2025'], ['swag', 'Swag']]), ignoredCategoryIds: new Set(), ...over };
}

describe('telling ticket numbers apart', () => {
  it('takes numbers standing on their own, not ones fused to letters or a hyphen', () => {
    expect(ticketNumbersIn('86882 roxa raven 2')).toEqual(['86882']);
    expect(ticketNumbersIn('Swap Item 59443')).toEqual(['59443']);
    expect(ticketNumbersIn('TShirt TSH-1938')).toEqual([]);
    expect(ticketNumbersIn('E6882')).toEqual([]);
  });
});

describe('classifying sales (D8)', () => {
  it('names last year’s archived copy of a ticket, and suggests our item', () => {
    const [issue] = classify(input({
      items: [item('73338')],
      lines: [line('o1', 'old-73338', { collectedCents: 4000 })],
      described: new Map([['old-73338', variation('old-73338', '73338', 'Swap Item 73338')]]),
    }));
    expect(issue).toMatchObject({ kind: 'other_copy', suggestion: { itemId: 'it-73338', sellerName: 'Karen Beckwith' }, rungUpAs: { archived: true, category: '2025' } });
  });

  it('matches an item made at the register by the one ticket number in its name', () => {
    const [issue] = classify(input({
      items: [item('86882', { name: 'Roxa Raven 2 19.5', sellerName: 'Little Mountain' })],
      lines: [line('o2', 'reg-1', { collectedCents: 5400 })],
      described: new Map([['reg-1', variation('reg-1', 'E6882', '86882 roxa raven 2', { categoryIds: [], archived: false })]]),
    }));
    expect(issue).toMatchObject({ kind: 'register_item', suggestion: { itemId: 'it-86882' } });
  });

  it('suggests nothing when a name has two of our ticket numbers', () => {
    const [issue] = classify(input({
      items: [item('73301'), item('73302')],
      lines: [line('o3', 'reg-2')],
      described: new Map([['reg-2', variation('reg-2', '', '73301 and 73302', { categoryIds: [], archived: false })]]),
    }));
    expect(issue).toMatchObject({ kind: 'other_item', suggestion: null });
  });

  it('calls out a ticket number no item has', () => {
    const [issue] = classify(input({
      lines: [line('o4', 'old-59443', { collectedCents: 1000 })],
      described: new Map([['old-59443', variation('old-59443', '59443', 'Swap Item 59443')]]),
    }));
    expect(issue).toMatchObject({ kind: 'unknown_ticket', ticket: '59443' });
  });

  it('lists a custom amount, and leaves out a category the swap ignores', () => {
    const issues = classify(input({
      lines: [line('o5', '', { name: 'Custom Amount' }), line('o6', 'tee')],
      described: new Map([['tee', variation('tee', 'TSH-1938', 'TShirt', { categoryIds: ['swag'], archived: false })]]),
      ignoredCategoryIds: new Set(['swag']),
    }));
    expect(issues.map((i) => i.kind)).toEqual(['custom_amount']);
  });

  it('leaves out our own items’ sales, decided lines, and lines refunded whole', () => {
    const issues = classify(input({
      items: [item('73338')],
      lines: [line('o7', 'v-73338'), line('o8', 'old-x'), line('o9', 'old-y', { refundedQuantity: 1, collectedCents: 0 })],
      decisions: [{ orderId: 'o8', lineUid: 'o8-u', decision: 'NOT_SWAP', itemId: null }],
    }));
    expect(issues).toEqual([]);
  });

  it('flags an item counted as sold more times than it has units', () => {
    const issues = classify(input({
      items: [item('73308')],
      lines: [line('a', 'v-73308'), line('b', 'old-73308')],
      decisions: [{ orderId: 'b', lineUid: 'b-u', decision: 'CREDIT', itemId: 'it-73308' }],
    }));
    expect(issues).toEqual([expect.objectContaining({ kind: 'oversold', oversold: expect.objectContaining({ units: 2, quantity: 1, orders: ['a', 'b'] }) })]);
  });
});

describe('every reader sees what was decided (D5)', () => {
  it('points a credited line at its item, drops a not-swap one, and leaves the rest', () => {
    const out = applyDecisions(
      [line('a', 'old-1'), line('b', 'tee'), line('c', 'v-ours'), line('d', 'old-2')],
      [
        { orderId: 'a', lineUid: 'a-u', decision: 'CREDIT', itemId: 'it-1' },
        { orderId: 'b', lineUid: 'b-u', decision: 'NOT_SWAP', itemId: null },
        { orderId: 'c', lineUid: 'c-u', decision: 'CREDIT', itemId: 'it-9' },
      ],
      new Set(['v-ours']),
      new Map([['it-1', 'v-1'], ['it-9', 'v-9']]),
    );
    expect(out.map((l) => [l.orderId, l.variationId])).toEqual([['a', 'v-1'], ['c', 'v-ours'], ['d', 'old-2']]);
  });
});

describe('payouts count a credited sale (D5)', () => {
  it('pays the seller at the typed price for an unpriced ticket, and drops a not-swap line from unmatched', () => {
    const items = [{ id: 'it-73338', name: 'Item #73338', sku: '73338', priceCents: null, squareVariationId: 'v-73338', donateProceeds: false, sellerId: 'karen' }];
    const sellers = [{ sellerId: 'karen', name: 'Karen Beckwith', method: 'CHECK' as const, target: null, handle: null, handleScanned: false, verifiedEmail: null, verifiedPhone: null }];
    const sales = applyDecisions(
      [line('o1', 'old-73338', { unitPriceCents: 4000, collectedCents: 4000 }), line('t', 'tee', { collectedCents: 2000 }), line('x', 'mystery', { collectedCents: 700 })],
      [{ orderId: 'o1', lineUid: 'o1-u', decision: 'CREDIT', itemId: 'it-73338' }, { orderId: 't', lineUid: 't-u', decision: 'NOT_SWAP', itemId: null }],
      new Set(['v-73338']), new Map([['it-73338', 'v-73338']]),
    );
    const run = buildRun(items, sellers, sales, { commissionBasisPoints: 0 });
    expect(run.lines).toEqual([expect.objectContaining({ sellerId: 'karen', grossCents: 4000 })]);
    expect(run.unmatched).toEqual([expect.objectContaining({ orderId: 'x', lineUid: 'x-u' })]);
  });
});

// ─── The service ─────────────────────────────────────────────────────────────

const WRITES = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|batchUpsert|batchCreateChanges|setInventoryPhysicalCount|setInitialInventory|deleteItem|deleteItems|syncItem|syncNewItems|upsertItems|renumberItemSkus)$/;

/** Throws on any write, so a read that writes fails the test (D13). */
function readOnly<T extends object>(target: T, path = 'db'): T {
  return new Proxy(target, {
    get(obj, prop: string) {
      const v = (obj as Record<string, unknown>)[prop];
      if (typeof v === 'function') {
        if (WRITES.test(prop)) return () => { throw new Error(`write during a read: ${path}.${prop}`); };
        return v.bind(obj);
      }
      return v && typeof v === 'object' ? readOnly(v as object, `${path}.${prop}`) : v;
    },
  });
}

function harness(opts: { lines: PosSaleLine[]; items: CheckItem[]; stock?: Record<string, number>; fees?: PosOrderFees[]; priceFails?: string }) {
  const decisions: Record<string, unknown>[] = [];
  const audits: string[] = [];
  const stockSet: [string, number][] = [];
  let forgotten = 0;
  const swap = { id: 'swap', orgId: 'org', locationId: 'loc', ignoredSquareCategoryIds: null as unknown };
  const prisma = {
    skiSwap: { findFirst: async () => swap, update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(swap, data) },
    swapItem: {
      findMany: async () => opts.items.map((i) => ({ ...i, deletedAt: i.deleted ? new Date() : null, seller: null })),
      findFirst: async ({ where }: { where: { sku: string } }) => {
        const i = opts.items.find((x) => x.sku === where.sku && !x.deleted);
        return i ? { id: i.id } : null;
      },
      updateMany: async ({ where, data }: { where: { id: string; priceCents?: null }; data: { priceCents: number } }) => {
        const i = opts.items.find((x) => x.id === where.id && (where.priceCents !== null || x.priceCents === null));
        if (i) i.priceCents = data.priceCents;
        return { count: i ? 1 : 0 };
      },
    },
    swapSaleDecision: {
      findMany: async () => decisions.filter((d) => d.liveKey),
      findFirst: async ({ where }: { where: { id: string } }) => decisions.find((d) => d.id === where.id && d.liveKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (decisions.some((d) => d.liveKey === data.liveKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        const row = { id: `d${decisions.length + 1}`, decidedAt: new Date(), markedSold: false, note: null, ...data };
        decisions.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(decisions.find((d) => d.id === where.id)!, data),
    },
    squareConfig: { findUnique: async () => ({ environment: 'production' }) },
    user: { findMany: async () => [] },
    auditLog: { create: async ({ data }: { data: { action: string } }) => { audits.push(data.action); } },
  };
  const pos = {
    describeVariations: async (ids: string[]) => new Map(ids.map((id) => [id, variation(id, id.replace('old-', ''), `Swap Item ${id.replace('old-', '')}`)])),
    listCategories: async () => new Map([['cat-2025', '2025']]),
    getSaleLine: async (orderId: string, lineUid: string) => opts.lines.find((l) => l.orderId === orderId && l.lineUid === lineUid) ?? null,
    getInventoryCounts: async (ids: string[]) => new Map(ids.map((id) => [id, opts.stock?.[id] ?? 1])),
    setInventoryPhysicalCount: async (id: string, _loc: string, n: number) => { stockSet.push([id, n]); },
  };
  const breakdown = {
    rawSales: async () => ({ at: at.getTime(), lines: opts.lines, fees: opts.fees, swap }),
    forgetSales: () => { forgotten++; },
  };
  /** Each item's price as it went to Square. */
  const pushedPrices: (number | null)[] = [];
  const issued = {
    batchAdd: async (_o: string, _s: string, _seller: string, tickets: string[]) => {
      opts.items.push(item(tickets[0], { squareVariationId: null, sellerName: 'New Seller' }));
      return { created: 1 };
    },
    push: async (_o: string, _s: string, ids: string[]) => {
      for (const i of opts.items) if (ids.includes(i.id)) { i.squareVariationId = `v-${i.sku}`; pushedPrices.push(i.priceCents); }
    },
  };
  const idempotency = { getCached: async () => null, save: async () => undefined };
  // The item edit (prices): records each patch; `opts.priceFails` makes it refuse.
  const patches: Record<string, unknown>[] = [];
  const itemsService = {
    patch: async (_o: string, _s: string, itemId: string, data: Record<string, unknown>) => {
      if (opts.priceFails) throw new ConflictException({ code: 'TICKET_PRICED', message: opts.priceFails });
      patches.push({ itemId, ...data });
      const it = opts.items.find((i) => i.id === itemId);
      if (it) it.priceCents = data.priceCents as number;
      return {};
    },
  };
  const make = (p: unknown, s: unknown) => new SalesCheckService(p as never, { forOrg: async () => s } as never, breakdown as never, issued as never, idempotency as never, itemsService as never);
  return {
    service: make(prisma, pos),
    readOnlyService: make(readOnly(prisma), readOnly(pos)),
    decisions, audits, stockSet, forgotten: () => forgotten, swap, patches, pushedPrices,
  };
}

describe('reading Sales check changes nothing (D13)', () => {
  it('lists and counts against a database and a Square that refuse every write', async () => {
    const h = harness({ items: [item('73338')], lines: [line('o1', 'old-73338')] });
    const res = await h.readOnlyService.list('org', 'swap');
    expect(res.issues).toEqual([expect.objectContaining({ kind: 'other_copy', links: expect.objectContaining({ sale: expect.stringContaining('pay-o1') }) })]);
    await expect(h.readOnlyService.count('org', 'swap')).resolves.toEqual({ open: 1, error: null });
  });
});

describe('crediting a sale to an item (D5, D6)', () => {
  it('re-reads the sale, records it, marks the item sold, clears the cache and audits', async () => {
    const h = harness({ items: [item('73338')], lines: [line('o1', 'old-73338')], stock: { 'v-73338': 1 } });
    await expect(h.service.credit('org', 'swap', { orderId: 'o1', lineUid: 'o1-u', itemId: 'it-73338', markSold: true }, 'staff'))
      .resolves.toEqual({ key: 'o1:o1-u', ok: true, markedSold: true });
    expect(h.decisions[0]).toMatchObject({ decision: 'CREDIT', itemId: 'it-73338', liveKey: 'o1:o1-u', markedSold: true });
    expect(h.stockSet).toEqual([['v-73338', 0]]);
    expect(h.forgotten()).toBe(1);
    expect(h.audits).toEqual(['ski_swap.sales_check.credited']);
  });

  it('leaves Square’s stock alone when it already reads sold', async () => {
    const h = harness({ items: [item('73338')], lines: [line('o1', 'old-73338')], stock: { 'v-73338': 0 } });
    await h.service.credit('org', 'swap', { orderId: 'o1', lineUid: 'o1-u', itemId: 'it-73338', markSold: true }, 'staff');
    expect(h.stockSet).toEqual([]);
  });

  it('refuses a sale already decided, one Square no longer has, and an item already sold', async () => {
    const h = harness({ items: [item('73338')], lines: [line('o1', 'old-73338'), line('o2', 'v-73338')] });
    await expect(h.service.credit('org', 'swap', { orderId: 'gone', lineUid: 'x', itemId: 'it-73338', markSold: true }, 'staff')).rejects.toThrow(/no longer has/);
    // o2 sold the item itself, so crediting o1 to it too would count it twice.
    await expect(h.service.credit('org', 'swap', { orderId: 'o1', lineUid: 'o1-u', itemId: 'it-73338', markSold: true }, 'staff')).rejects.toThrow(/already counted as sold/);
    expect(h.decisions).toEqual([]);
  });

  it('credits exactly the lines it was sent, each on its own merits', async () => {
    const h = harness({ items: [item('1'), item('2'), item('3')], lines: [line('a', 'old-1'), line('b', 'old-2'), line('c', 'old-3')] });
    const res = await h.service.creditMany('org', 'swap', { lines: [{ orderId: 'a', lineUid: 'a-u', itemId: 'it-1' }, { orderId: 'b', lineUid: 'b-u', itemId: 'it-9' }], markSold: false }, 'staff');
    expect(res.outcomes).toEqual([{ key: 'a:a-u', ok: true, markedSold: false }, { key: 'b:b-u', ok: false, error: 'That item isn’t in this swap.' }]);
    expect(h.decisions.map((d) => d.orderId)).toEqual(['a']);
  });

  it('records a sale that isn’t the swap’s, and undoing re-opens it', async () => {
    const h = harness({ items: [], lines: [line('t', 'tee')] });
    await h.service.notSwapSale('org', 'swap', { orderId: 't', lineUid: 't-u', note: 'swag' }, 'staff');
    expect((await h.service.list('org', 'swap')).issues).toEqual([]);
    await h.service.undo('org', 'swap', 'd1', 'staff');
    expect((await h.service.list('org', 'swap')).issues).toHaveLength(1);
  });

  it('issues an unknown ticket to a seller at Square’s price, puts it in Square priced, then credits the sale (D9)', async () => {
    const h = harness({ items: [], lines: [line('u', 'old-59443', { collectedCents: 1000, unitPriceCents: 1000 })] });
    await expect(h.service.issueAndCredit('org', 'swap', { orderId: 'u', lineUid: 'u-u', sellerId: 'seller', ticket: '59443' }, 'staff'))
      .resolves.toMatchObject({ ok: true, pricedCents: 1000 });
    expect(h.decisions[0]).toMatchObject({ itemId: 'it-59443' });
    expect(h.pushedPrices).toEqual([1000]);
    expect(h.audits).toEqual(['ski_swap.sales_check.credited', 'ski_swap.sales_check.issued_and_credited']);
  });

  it('remembers a category the swap never counts', async () => {
    const h = harness({ items: [], lines: [] });
    await expect(h.service.ignoreCategory('org', 'swap', { categoryId: 'swag', ignore: true }, 'staff')).resolves.toEqual({ ignored: ['swag'] });
    expect(h.swap.ignoredSquareCategoryIds).toEqual(['swag']);
  });
});

describe('the Sales check routes (D1, D13)', () => {
  const reflector = new Reflector();
  const handlers = Object.getOwnPropertyNames(SalesCheckController.prototype).filter((n) => n !== 'constructor') as (keyof SalesCheckController)[];

  it('read with report access, and change nothing', () => {
    for (const name of ['list', 'count'] as const) {
      expect(Reflect.getMetadata(METHOD_METADATA, SalesCheckController.prototype[name])).toBe(RequestMethod.GET);
      expect(reflector.get(PERMISSIONS_KEY, SalesCheckController.prototype[name])).toEqual(['ski_swap:report']);
    }
  });

  it('make every change a POST that needs an admin', () => {
    const changes = handlers.filter((n) => n !== 'list' && n !== 'count');
    expect(changes.sort()).toEqual(['credit', 'creditSuggested', 'feeHandled', 'ignoreCategory', 'issueAndCredit', 'notSwap', 'restock', 'undo']);
    for (const name of changes) {
      expect(Reflect.getMetadata(METHOD_METADATA, SalesCheckController.prototype[name])).toBe(RequestMethod.POST);
      expect(reflector.get(PERMISSIONS_KEY, SalesCheckController.prototype[name])).toEqual(['ski_swap:admin']);
    }
  });
});

describe('what open sales hold back in Catalog check', () => {
  it('names each ticket and Square item a sale involves, never a fused number', async () => {
    const { salesHolds, heldBy } = await import('./sales-check');
    const holds = salesHolds([
      { key: 'a', ticket: null, suggestion: { itemId: 'i', sku: '73338', name: 'x', priceCents: null, sellerName: null, sellerId: null },
        rungUpAs: { name: 'Swap Item 73338', sku: '73338', variationId: 'v', itemId: 'old-73338', category: '2025', archived: true } },
      { key: 'b', ticket: '59443', suggestion: null, rungUpAs: { name: 'Swap Item 59443', sku: '59443', variationId: 'v2', itemId: 'old-59443', category: '2025', archived: true } },
      { key: 'c', ticket: null, suggestion: null, oversold: { itemId: 'it', sku: '87688', name: 'Elan', units: 2, quantity: 1, orders: [] }, rungUpAs: null },
      { key: 'd', ticket: null, suggestion: null, rungUpAs: { name: 'TShirt', sku: 'TSH-1938', variationId: 'v3', itemId: 'tee', category: 'Swag', archived: false } },
    ]);
    expect(heldBy(holds, '73338', [])).toBe(1);
    expect(heldBy(holds, '99999', ['old-73338'])).toBe(1);
    expect(heldBy(holds, '59443', ['old-59443'])).toBe(1);
    expect(heldBy(holds, '87688', [])).toBe(1);
    expect(heldBy(holds, '1938', [])).toBe(0);
    expect(heldBy(holds, '73001', ['old-73001'])).toBe(0);
  });
});

describe('the fee check in Sales check', () => {
  const fees = (shopRefunded = 0): PosOrderFees[] => [{
    orderId: 'f1', paymentId: 'pay-f1', soldAt: at, hasLines: true, cardCents: 31054, cashCents: 0,
    charges: [
      { uid: 'shop', name: 'Shop Fee', surcharge: false, percentage: '2.6', cents: 767, refundedCents: shopRefunded },
      { uid: 'sur', name: 'Credit card surcharge', surcharge: true, percentage: '2.6', cents: 787, refundedCents: 0 },
    ],
  }, { orderId: 'f2', paymentId: 'pay-f2', soldAt: at, hasLines: true, cardCents: 5000, cashCents: 0, charges: [] }];

  it('lists a sale charged both fees, links it, and counts card sales with none, without writing', async () => {
    const h = harness({ items: [], lines: [], fees: fees() });
    const res = await h.readOnlyService.list('org', 'swap');
    expect(res.issues).toEqual([expect.objectContaining({
      key: 'f1:#fee', kind: 'double_fee', collectedCents: 767, links: expect.objectContaining({ sale: expect.stringContaining('pay-f1') }),
      fee: { shopFeeName: 'Shop Fee', shopFeeCents: 767, surchargeCents: 787, cardCents: 31054, cashCents: 0, refundCents: 767 },
    })]);
    expect(res.missedFees).toEqual({ orders: 1, cardCents: 5000, feeCents: 130, percentage: '2.6' });
  });

  it('clears once Square shows the fee refunded', async () => {
    const h = harness({ items: [], lines: [], fees: fees(767) });
    expect((await h.service.list('org', 'swap')).issues).toEqual([]);
  });

  it('marks one handled once, leaves the sales alone, and undoes', async () => {
    const h = harness({ items: [item('73338')], lines: [line('o1', 'v-73338')], fees: fees() });
    await expect(h.service.feeHandled('org', 'swap', { orderId: 'f1' }, 'staff')).resolves.toEqual({ key: 'f1:#fee', ok: true });
    expect(h.decisions[0]).toMatchObject({ decision: 'FEE_HANDLED', lineUid: '#fee', collectedCents: 767, liveKey: 'f1:#fee' });
    expect(h.audits).toEqual(['ski_swap.sales_check.fee_handled']);
    const after = await h.service.list('org', 'swap');
    expect([after.issues, after.decided.map((d) => [d.decision, d.key])]).toEqual([[], [['FEE_HANDLED', 'f1:#fee']]]);
    await expect(h.service.feeHandled('org', 'swap', { orderId: 'f1' }, 'staff')).resolves.toMatchObject({ ok: false });
    await h.service.undo('org', 'swap', 'd1', 'staff');
    expect((await h.service.list('org', 'swap')).issues.map((i) => i.key)).toEqual(['f1:#fee']);
  });
});

describe('accepting a sale onto an unpriced item, with a price', () => {
  it('credits the sale, then prices the item through the item edit, only if still unpriced', async () => {
    const h = harness({ items: [item('73338')], lines: [line('o1', 'old-73338')], stock: { 'v-73338': 1 } });
    await expect(h.service.credit('org', 'swap', { orderId: 'o1', lineUid: 'o1-u', itemId: 'it-73338', markSold: true, priceCents: 4000 }, 'staff'))
      .resolves.toEqual({ key: 'o1:o1-u', ok: true, markedSold: true, pricedCents: 4000 });
    expect(h.decisions[0]).toMatchObject({ decision: 'CREDIT', itemId: 'it-73338' });
    expect(h.patches).toEqual([{ itemId: 'it-73338', priceCents: 4000, ifUnpriced: true, actorId: 'staff' }]);
    expect(h.audits).toEqual(['ski_swap.sales_check.credited', 'ski_swap.sales_check.priced']);
  });

  it('refuses a price for an item that has one, and credits nothing', async () => {
    const h = harness({ items: [item('73338', { priceCents: 5000 })], lines: [line('o1', 'old-73338')] });
    await expect(h.service.credit('org', 'swap', { orderId: 'o1', lineUid: 'o1-u', itemId: 'it-73338', markSold: true, priceCents: 4000 }, 'staff'))
      .rejects.toThrow('73338 already has a price ($50.00)');
    expect([h.decisions, h.patches]).toEqual([[], []]);
  });

  it('keeps the credit and says so when the price is refused meanwhile', async () => {
    const h = harness({ items: [item('73338')], lines: [line('o1', 'old-73338')], priceFails: '73338 already has a price ($45.00).' });
    await expect(h.service.credit('org', 'swap', { orderId: 'o1', lineUid: 'o1-u', itemId: 'it-73338', markSold: true, priceCents: 4000 }, 'staff'))
      .resolves.toMatchObject({ ok: true, priceError: '73338 already has a price ($45.00).' });
    expect(h.decisions).toHaveLength(1);
  });
});

describe('a ticket scanned twice in one sale', () => {
  const old = new Map([['old-73475', variation('old-73475', '73475', 'Swap Item 73475')]]);

  it('is a second scan when the same order already sold the item (10/09, 73475 Poles)', () => {
    const issues = classify(input({
      items: [item('73475', { name: 'Poles', priceCents: 2200 })],
      lines: [
        line('xV', 'old-73475', { lineUid: 'old', collectedCents: 1950, unitPriceCents: 1950 }),
        line('xV', 'v-73475', { lineUid: 'ours', collectedCents: 2200, unitPriceCents: 2200 }),
      ],
      described: old,
    }));
    expect(issues.map((i) => [i.kind, i.lineUid, i.suggestion?.sku])).toEqual([['scanned_twice', 'old', '73475']]);
  });

  it('counts a sale already put on the item in Sales check, in the same order', () => {
    const issues = classify(input({
      items: [item('73475')],
      lines: [line('o1', 'old-73475', { lineUid: 'a' }), line('o1', 'old-73475', { lineUid: 'b' })],
      decisions: [{ orderId: 'o1', lineUid: 'a', decision: 'CREDIT', itemId: 'it-73475' }],
      described: old,
    }));
    expect(issues.map((i) => [i.kind, i.lineUid])).toEqual([['scanned_twice', 'b']]);
  });

  it('is still another copy when the item sold in a different order, or has units to spare', () => {
    expect(classify(input({
      items: [item('73475')],
      lines: [line('o1', 'v-73475'), line('o2', 'old-73475')],
      described: old,
    })).map((i) => i.kind)).toEqual(['other_copy']);
    expect(classify(input({
      items: [item('73475', { originalQuantity: 2 })],
      lines: [line('o1', 'v-73475', { lineUid: 'a' }), line('o1', 'old-73475', { lineUid: 'b' })],
      described: old,
    })).map((i) => i.kind)).toEqual(['other_copy']);
  });
});

