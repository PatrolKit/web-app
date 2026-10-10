import { ConflictException } from '@nestjs/common';
import { SwapDiagnosticsService } from './swap-diagnostics.service';
import type { PosCatalogItem, PosItemSync } from '../pos/pos.adapter';
import { claimRead, claimUpdate, isClaimCall } from '../__fixtures__/claim-fake';
import { salesHolds } from '../sales-check';

/**
 * Swap diagnostics end to end (Plan 41), against an in-memory database and
 * an in-memory Square category.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a fake of Prisma, whose rows are loosely typed
type Row = Record<string, any>;
const SWAP = { id: 'swap', orgId: 'org', title: 'Spring Swap', squareCategoryId: 'cat', locationId: 'loc' };

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('in' in v) return (v.in as unknown[]).includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
      return true;
    }
    return row[k] === v;
  });
}

function harness() {
  const db = {
    items: [] as Row[],
    runs: [] as Row[],
    issues: [] as Row[],
    hidden: [] as Row[],
    audit: [] as Row[],
  };
  let square: PosCatalogItem[] = [];
  const elsewhere: PosCatalogItem[] = [];
  const renumbered: [string, string][] = [];
  const squareWrites: PosItemSync[][] = [];
  const squareDeletes: string[][] = [];
  let failListing: Error | null = null;
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;

  const prisma = {
    squareConfig: { findUnique: async () => ({ environment: 'production' }) },
    skiSwap: {
      findFirst: async () => SWAP,
      update: async () => SWAP,
    },
    swapDiagnosticRun: {
      findFirst: async ({ where, include }: Row) => {
        const run = db.runs.filter((r) => matches(r, where)).sort((a, b) => b.startedAt - a.startedAt)[0];
        if (!run) return null;
        return include ? { ...run, issues: db.issues.filter((i) => i.runId === run.id) } : run;
      },
      create: async ({ data }: Row) => {
        const run = { done: 0, ourCount: null, squareCount: null, error: null, finishedAt: null, startedAt: new Date(Date.now() + n), updatedAt: new Date(), ...data, id: id('run') };
        db.runs.push(run);
        return run;
      },
      update: async ({ where, data }: Row) => Object.assign(db.runs.find((r) => r.id === where.id)!, data, { updatedAt: new Date() }),
      findMany: async ({ where, skip }: Row) =>
        db.runs.filter((r) => matches(r, where)).sort((a, b) => b.startedAt - a.startedAt).slice(skip ?? 0),
      deleteMany: async ({ where }: Row) => {
        const ids = new Set(where.id.in);
        db.runs = db.runs.filter((r) => !ids.has(r.id));
        db.issues = db.issues.filter((i) => !ids.has(i.runId));
      },
    },
    swapDiagnosticIssue: {
      createMany: async ({ data }: Row) => {
        for (const d of data) {
          db.issues.push({ state: 'open', choice: null, decidedBy: null, decidedAt: null, error: null, ...d, ours: d.ours?.toJSON ? null : d.ours, square: d.square?.toJSON ? null : d.square, id: id('issue') });
        }
      },
      findFirst: async ({ where }: Row) => db.issues.find((i) => matches(i, where)) ?? null,
      findMany: async ({ where }: Row) => db.issues.filter((i) => matches(i, where)),
      update: async ({ where, data }: Row) => Object.assign(db.issues.find((i) => i.id === where.id)!, data),
      findUniqueOrThrow: async ({ where }: Row) => db.issues.find((i) => i.id === where.id)!,
    },
    swapDiagnosticHidden: {
      upsert: async ({ create }: Row) => { db.hidden.push(create); return create; },
      findMany: async ({ where }: Row) => db.hidden.filter((h) => matches(h, where)),
    },
    swapItem: {
      findMany: async ({ where }: Row) => (isClaimCall(where) ? claimRead(db.items as never, where)
        : db.items.filter((r) => matches(r, where)).map((r) => ({ ...r, seller: null }))),
      updateMany: async ({ where, data }: Row) => claimUpdate(db.items as never, where, data),
      findFirst: async ({ where }: Row) => db.items.find((r) => matches(r, where)) ?? null,
      update: async ({ where, data }: Row) => Object.assign(db.items.find((r) => r.id === where.id)!, data),
    },
    user: { findMany: async () => [{ id: 'staff', firstName: 'Dana', lastName: 'Smith', email: null }] },
    auditLog: { createMany: async ({ data }: Row) => { db.audit.push(...data); } },
  };

  const pos = {
    listCategoryItems: async (cat: string, onPage?: (n: number) => void) => {
      if (failListing) throw failListing;
      const rows = square.filter(() => cat === 'cat');
      onPage?.(rows.length);
      return rows;
    },
    itemsBySku: async (_cat: string, skus: string[]) => square.filter((s) => skus.includes(s.sku)),
    // Plan 48 D11: other copies anywhere, archived included. None unless a test adds them.
    itemsBySkuAnywhere: async (skus: string[]) => elsewhere.filter((s) => skus.includes(s.sku)),
    listCategories: async () => new Map([['cat', 'Ski Swap 2026'], ['old', '2025']]),
    renumberItemSkus: async (itemId: string, prefix: string) => { renumbered.push([itemId, prefix]); },
    upsertItems: async (items: PosItemSync[]) => {
      squareWrites.push(items);
      return {
        resolvedCategoryId: 'cat',
        results: items.map((it) => {
          const existing = square.find((s) => s.itemId === it.posItemId);
          const entry: PosCatalogItem = {
            itemId: existing?.itemId ?? id('sq'), variationId: existing?.variationId ?? id('sv'), sku: it.sku, name: it.name,
            description: it.description ?? null, version: '2', updatedAt: null,
            pricing: it.priceCents === null ? { type: 'variable' } : { type: 'fixed', cents: it.priceCents },
          };
          square = [...square.filter((s) => s.itemId !== entry.itemId), entry];
          return { posItemId: entry.itemId, posVariationId: entry.variationId };
        }),
      };
    },
    deleteItems: async (ids: string[]) => { squareDeletes.push(ids); square = square.filter((s) => !ids.includes(s.itemId)); },
  };

  const created: Row[] = [];
  const items = {
    create: async (_org: string, _swap: string, data: Row) => {
      created.push(data);
      db.items.push({ id: id('item'), swapId: 'swap', sku: data.sku, name: data.fallbackName, description: data.description ?? null, priceCents: data.priceCents, consignedAt: new Date(), deletedAt: null, squareItemId: data.squareIds.itemId, squareVariationId: data.squareIds.variationId });
    },
  };

  // Sales check's open sales (Plan 48): none unless a test opens one.
  const openSales: Parameters<typeof salesHolds>[0] = [];
  let salesError: string | null = null;
  const salesCheck = { holds: async () => (salesError ? { error: salesError } : salesHolds(openSales)) };

  const service = new SwapDiagnosticsService(prisma as never, { forOrg: async () => pos } as never, items as never, salesCheck as never);

  const run = async () => {
    const { runId } = await service.start('org', 'swap', 'staff');
    for (let i = 0; i < 50 && db.runs.find((r) => r.id === runId)!.status === 'running'; i++) await new Promise(setImmediate);
    return (await service.latest('org', 'swap'))!;
  };

  return {
    db, service, run, created, squareWrites, squareDeletes, renumbered, openSales,
    /** An open Sales check sale rung up on this Square item, suggesting this ticket. */
    openSale: (key: string, sku: string, squareItemId: string) => openSales.push({
      key, ticket: null, rungUpAs: { name: `Swap Item ${sku}`, sku, variationId: `v-${key}`, itemId: squareItemId, category: '2025', archived: true },
      suggestion: { itemId: `our-${sku}`, sku, name: 'Red Skis', priceCents: null, sellerName: null, sellerId: null },
    }),
    salesUnreadable: (err: string | null) => { salesError = err; },
    /** Another Square item with this SKU (Plan 48 D11): last year's archived copy by default. */
    elsewhere: (sku: string, over: Partial<PosCatalogItem> = {}) => {
      const entry: PosCatalogItem = { itemId: `old-${sku}`, variationId: `oldv-${sku}`, sku, name: `Swap Item ${sku}`, description: null, pricing: { type: 'variable' }, version: '1', updatedAt: null, categoryIds: ['old'], archived: true, ...over };
      elsewhere.push(entry);
      return entry;
    },
    ours: (sku: string, over: Row = {}) => {
      const row = { id: `our-${sku}`, swapId: 'swap', sku, name: 'Red Skis', description: null, priceCents: 4500, consignedAt: new Date(), deletedAt: null, squareItemId: `sq-${sku}`, squareVariationId: `sv-${sku}`, ...over };
      db.items.push(row);
      return row;
    },
    square: (sku: string, over: Partial<PosCatalogItem> = {}) => {
      const entry: PosCatalogItem = { itemId: `sq-${sku}`, variationId: `sv-${sku}`, sku, name: 'Red Skis', description: null, pricing: { type: 'fixed', cents: 4500 }, version: '1', updatedAt: null, ...over };
      square.push(entry);
      return entry;
    },
    setSquarePrice: (sku: string, cents: number) => {
      square = square.map((s) => (s.sku === sku ? { ...s, pricing: { type: 'fixed', cents } } : s));
    },
    failNextListing: (err: Error) => { failListing = err; },
  };
}

const open = (run: { issues: { state: string; kind: string; field: string | null; sku: string; id: string }[] }) =>
  run.issues.filter((i) => i.state === 'open').map((i) => [i.sku, i.kind, i.field]);

describe('swap diagnostics runs (Plan 41 D9, D10)', () => {
  it('records each issue, the counts, and who ran it', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000 });
    h.square('1');
    h.square('2');
    const run = await h.run();
    expect(run).toMatchObject({ status: 'done', ourCount: 1, squareCount: 2, startedByName: expect.stringContaining('Dana') });
    expect(open(run)).toEqual([['1', 'differs', 'price'], ['2', 'only_square', null]]);
  });

  it('answers the run already going instead of starting another', async () => {
    const h = harness();
    h.db.runs.push({ id: 'going', orgId: 'org', swapId: 'swap', status: 'running', startedAt: new Date(), updatedAt: new Date() });
    expect(await h.service.start('org', 'swap', 'staff')).toEqual({ runId: 'going' });
  });

  it('shows a run silent for ten minutes as interrupted, and starts afresh', async () => {
    const h = harness();
    const old = new Date(Date.now() - 11 * 60 * 1000);
    h.db.runs.push({ id: 'stuck', orgId: 'org', swapId: 'swap', status: 'running', startedAt: old, updatedAt: old, issues: [] });
    expect((await h.service.latest('org', 'swap'))!.status).toBe('interrupted');
    const run = await h.run();
    expect(run.id).not.toBe('stuck');
    expect(h.db.runs.find((r) => r.id === 'stuck')!.status).toBe('failed');
  });

  it('records a failure with Square’s message', async () => {
    const h = harness();
    h.failNextListing(new Error('Square is down'));
    expect(await h.run()).toMatchObject({ status: 'failed', error: 'Square is down' });
  });

  it('keeps the last 30 runs', async () => {
    const h = harness();
    for (let i = 0; i < 32; i++) await h.run();
    expect(h.db.runs).toHaveLength(30);
  });
});

describe('Mark resolved (D5)', () => {
  it('records an issue fixed by hand since the run as fixed, hides nothing, and raises it if it returns', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000 });
    h.square('1');
    const run = await h.run();
    h.setSquarePrice('1', 5000);
    const issue = await h.service.apply('org', 'swap', run.issues[0].id, 'resolve', {}, 'staff');
    expect(issue).toMatchObject({ state: 'fixed', decidedByName: expect.stringContaining('Dana') });
    expect(h.db.hidden).toEqual([]);
    h.setSquarePrice('1', 4500);
    expect(open(await h.run())).toEqual([['1', 'differs', 'price']]);
  });

  it('hides an issue left as is until a value changes, for every kind', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000 });
    h.square('1');
    h.square('2');
    h.ours('3');
    h.ours('4', { squareItemId: null });
    h.square('4');
    const run = await h.run();
    expect(open(run)).toHaveLength(4);
    for (const issue of run.issues) {
      expect(await h.service.apply('org', 'swap', issue.id, 'resolve', {}, 'staff')).toMatchObject({ state: 'left' });
    }
    expect(open(await h.run())).toEqual([]);
    h.setSquarePrice('1', 4000);
    expect(open(await h.run())).toEqual([['1', 'differs', 'price']]);
  });

  it('hides the values at the click when they changed but still disagree', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000 });
    h.square('1');
    const run = await h.run();
    h.setSquarePrice('1', 4800);
    await h.service.apply('org', 'swap', run.issues[0].id, 'resolve', {}, 'staff');
    expect(open(await h.run())).toEqual([]);
  });

  it('is accepted for a whole group, changed rows included', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000 });
    h.square('1');
    h.ours('2', { priceCents: 5000 });
    h.square('2');
    const run = await h.run();
    h.setSquarePrice('1', 5000);
    expect(await h.service.applyAll('org', 'swap', run.id, { kind: 'differs', field: 'price' }, 'resolve', {}, 'staff'))
      .toEqual({ applied: 2, skipped: 0, failed: 0, held: 0 });
  });
});

describe('the other choices (D3, D4, D6)', () => {
  it('Copy to Square sends ours and links it', async () => {
    const h = harness();
    const ours = h.ours('1', { squareItemId: null, squareVariationId: null });
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'copy_to_square', {}, 'staff');
    expect(h.squareWrites[0][0]).toMatchObject({ sku: '1', name: 'Red Skis', priceCents: 4500 });
    expect(ours.squareItemId).toBeTruthy();
    expect(open(await h.run())).toEqual([]);
  });

  it('Use ours sends our details to the Square item it was compared with, without linking', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000, squareItemId: null, squareVariationId: null });
    h.square('1');
    const run = await h.run();
    const price = run.issues.find((i) => i.kind === 'differs')!;
    await h.service.apply('org', 'swap', price.id, 'use_ours', {}, 'staff');
    expect(h.squareWrites[0][0]).toMatchObject({ posItemId: 'sq-1', priceCents: 5000 });
    expect(open(await h.run())).toEqual([['1', 'not_linked', null]]);
  });

  it('Set a new price writes it to ours and sends it to the Square item it was compared with', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000 });
    h.square('1');
    const run = await h.run();
    const price = run.issues.find((i) => i.kind === 'differs')!;
    expect(price.squareUrl).toBe('https://app.squareup.com/dashboard/items/library/sq-1');
    await h.service.apply('org', 'swap', price.id, 'set_price', { priceCents: 4000 }, 'staff');
    expect(h.db.items.find((i) => i.sku === '1')!.priceCents).toBe(4000);
    expect(h.squareWrites[0][0]).toMatchObject({ posItemId: 'sq-1', priceCents: 4000 });
    expect(open(await h.run())).toEqual([]);
  });

  it('Set a new price is refused without a price, off Price differs, or for a whole group', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000, name: 'Blue Skis' });
    h.square('1');
    const run = await h.run();
    const price = run.issues.find((i) => i.field === 'price')!;
    const name = run.issues.find((i) => i.field === 'name')!;
    await expect(h.service.apply('org', 'swap', price.id, 'set_price', {}, 'staff')).rejects.toThrow('with the price');
    await expect(h.service.apply('org', 'swap', name.id, 'set_price', { priceCents: 4000 }, 'staff')).rejects.toThrow('with the price');
    await expect(h.service.applyAll('org', 'swap', run.id, { kind: 'differs', field: 'price' }, 'set_price', { priceCents: 4000 }, 'staff')).rejects.toThrow('one item at a time');
    expect(h.squareWrites).toEqual([]);
  });

  it('Use Square’s writes Square’s value to ours, and sends nothing', async () => {
    const h = harness();
    const ours = h.ours('1', { name: 'Blue Skis' });
    h.square('1');
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'use_square', {}, 'staff');
    expect(ours.name).toBe('Red Skis');
    expect(h.squareWrites).toEqual([]);
  });

  it('Use Square’s "no price" is refused for anything but a ticket', async () => {
    const h = harness();
    h.ours('SP-0001');
    h.square('SP-0001', { pricing: { type: 'variable' } });
    const run = await h.run();
    expect(await h.service.apply('org', 'swap', run.issues[0].id, 'use_square', {}, 'staff'))
      .toMatchObject({ state: 'failed', error: 'Only a ticket can be without a price.' });
  });

  it('Link to it stores the ids and sends nothing to Square', async () => {
    const h = harness();
    const ours = h.ours('1', { squareItemId: null, squareVariationId: null });
    h.square('1');
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'link', {}, 'staff');
    expect(ours).toMatchObject({ squareItemId: 'sq-1', squareVariationId: 'sv-1' });
    expect(h.squareWrites).toEqual([]);
  });

  it('Keep this copy links ours to it and deletes the others from Square', async () => {
    const h = harness();
    const ours = h.ours('1');
    h.square('1');
    h.square('1', { itemId: 'sq-dup', variationId: 'sv-dup' });
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'keep', { keepSquareItemId: 'sq-dup' }, 'staff');
    expect(ours.squareItemId).toBe('sq-dup');
    expect(h.squareDeletes).toEqual([['sq-1']]);
  });

  it('Copy to PatrolKit creates the item for the seller, linked, or restores a deleted one', async () => {
    const h = harness();
    h.square('1', { name: 'Sled', pricing: { type: 'fixed', cents: 2000 } });
    const gone = h.ours('2', { deletedAt: new Date(), squareItemId: null });
    h.square('2');
    const run = await h.run();
    const [one, two] = run.issues;
    await h.service.apply('org', 'swap', one.id, 'copy_to_patrolkit', { sellerId: 'seller-1' }, 'staff');
    expect(h.created[0]).toMatchObject({ sku: '1', fallbackName: 'Sled', priceCents: 2000, sellerId: 'seller-1', squareIds: { itemId: 'sq-1', variationId: 'sv-1' } });
    await h.service.apply('org', 'swap', two.id, 'copy_to_patrolkit', { restoreItemId: gone.id }, 'staff');
    expect(gone).toMatchObject({ deletedAt: null, liveSku: '2', squareItemId: 'sq-2' });
  });

  it('refuses a choice when the issue changed since the run (D6)', async () => {
    const h = harness();
    h.ours('1', { priceCents: 5000 });
    h.square('1');
    const run = await h.run();
    h.setSquarePrice('1', 4800);
    await expect(h.service.apply('org', 'swap', run.issues[0].id, 'use_ours', {}, 'staff')).rejects.toBeInstanceOf(ConflictException);
  });

  it('applies a group choice to open rows only, skipping changed ones', async () => {
    const h = harness();
    h.ours('1', { squareItemId: null, squareVariationId: null });
    h.ours('2', { squareItemId: null, squareVariationId: null });
    h.ours('3', { squareItemId: null, squareVariationId: null });
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'resolve', {}, 'staff');
    h.db.items.find((r) => r.sku === '2')!.name = 'Changed';
    expect(await h.service.applyAll('org', 'swap', run.id, { kind: 'only_ours' }, 'copy_to_square', {}, 'staff'))
      .toEqual({ applied: 1, skipped: 1, failed: 0, held: 0 });
  });

  it('audits every choice with both values', async () => {
    const h = harness();
    h.ours('1', { squareItemId: null, squareVariationId: null });
    h.square('1');
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'link', {}, 'staff');
    expect(h.db.audit[0]).toMatchObject({
      actorId: 'staff', action: 'ski_swap.diagnostics.applied',
      metadata: { sku: '1', kind: 'not_linked', choice: 'link', ours: expect.any(Object), square: expect.any(Object) },
    });
  });
});

describe('another Square item with our ticket number (Plan 48 D11)', () => {
  it('finds last year’s archived copy, and says where it is', async () => {
    const h = harness();
    h.ours('73789');
    h.square('73789');
    h.elsewhere('73789');
    h.elsewhere('99999'); // not one of ours: not this swap's business
    const run = await h.run();
    expect(run.issues).toEqual([expect.objectContaining({
      sku: '73789', kind: 'elsewhere',
      square: { copies: [expect.objectContaining({ itemId: 'old-73789', archived: true, category: '2025' })] },
    })]);
  });

  it('re-numbers it with the year its category is named for, and keeps the item', async () => {
    const h = harness();
    h.ours('73789');
    h.square('73789');
    h.elsewhere('73789');
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'renumber_other', {}, 'staff');
    expect(h.renumbered).toEqual([['old-73789', '2025']]);
  });

  it('asks for a prefix when the category isn’t a year, and uses the one given', async () => {
    const h = harness();
    h.ours('73789');
    h.square('73789');
    h.elsewhere('73789', { categoryIds: ['cat-x'] });
    const run = await h.run();
    await h.service.apply('org', 'swap', run.issues[0].id, 'renumber_other', {}, 'staff');
    expect((await h.service.latest('org', 'swap'))!.issues[0]).toMatchObject({ state: 'failed', error: expect.stringContaining('Give a prefix') });
    await h.service.apply('org', 'swap', run.issues[0].id, 'renumber_other', { prefix: 'OLD' }, 'staff');
    expect(h.renumbered).toEqual([['old-73789', 'OLD']]);
  });

  it('deletes the other copy, but never one PatrolKit has come to link', async () => {
    const h = harness();
    h.ours('73789');
    h.square('73789');
    h.elsewhere('73789');
    h.ours('73790');
    h.square('73790');
    h.elsewhere('73790');
    const run = await h.run();
    const [first, second] = run.issues;
    await h.service.apply('org', 'swap', first.id, 'delete_other', {}, 'staff');
    expect(h.squareDeletes).toEqual([['old-73789']]);
    // Linked since the run, by a withdrawn item of ours.
    h.db.items.push({ id: 'gone', orgId: 'org', swapId: 'swap', sku: 'x', deletedAt: new Date(), squareItemId: 'old-73790' });
    await expect(h.service.apply('org', 'swap', second.id, 'delete_other', {}, 'staff')).rejects.toThrow();
    expect(h.squareDeletes).toEqual([['old-73789']]);
  });
});

describe('open sales hold back their tickets (Plan 48)', () => {
  it('flags an issue whose ticket or Square item has an open sale, with how many', async () => {
    const h = harness();
    h.ours('73789'); h.square('73789'); h.elsewhere('73789');
    h.ours('73790'); h.square('73790'); h.elsewhere('73790');
    h.openSale('o1:l1', '73789', 'old-73789');
    h.openSale('o2:l1', '73789', 'old-73789');
    const run = await h.run();
    expect(run.issues.map((i) => [i.sku, i.heldBySales])).toEqual([['73789', 2], ['73790', 0]]);
    expect(run.issues[0].squareUrl).toBeNull(); // elsewhere names its copies, not one item
    expect(run.salesCheckError).toBeNull();
  });

  it('refuses every choice on a held issue, until the sale is settled', async () => {
    const h = harness();
    h.ours('73789'); h.square('73789'); h.elsewhere('73789');
    h.openSale('o1:l1', '73789', 'old-73789');
    const [issue] = (await h.run()).issues;
    for (const choice of ['delete_other', 'renumber_other', 'resolve'] as const) {
      await expect(h.service.apply('org', 'swap', issue.id, choice, {}, 'staff')).rejects.toThrow('Ticket 73789 has an open sale in Sales check');
    }
    expect([h.squareDeletes, h.renumbered]).toEqual([[], []]);

    h.openSales.length = 0; // settled in Sales check
    await h.service.apply('org', 'swap', issue.id, 'delete_other', {}, 'staff');
    expect(h.squareDeletes).toEqual([['old-73789']]);
  });

  it('holds an issue named by the Square item alone, whatever the ticket', async () => {
    const h = harness();
    h.ours('73789'); h.square('73789'); h.elsewhere('73789');
    h.openSale('o1:l1', '11111', 'old-73789');
    const [issue] = (await h.run()).issues;
    expect(issue.heldBySales).toBe(1);
  });

  it('leaves held issues out of a group choice, and says how many', async () => {
    const h = harness();
    for (const sku of ['73789', '73790', '73791']) { h.ours(sku); h.square(sku); h.elsewhere(sku); }
    h.openSale('o1:l1', '73790', 'old-73790');
    const run = await h.run();
    const res = await h.service.applyAll('org', 'swap', run.id, { kind: 'elsewhere' }, 'delete_other', {}, 'staff');
    expect(res).toEqual({ applied: 2, skipped: 0, failed: 0, held: 1 });
    expect(h.squareDeletes.flat().sort()).toEqual(['old-73789', 'old-73791']);
    expect((await h.service.latest('org', 'swap'))!.issues.find((i) => i.sku === '73790')).toMatchObject({ state: 'open', heldBySales: 1 });
  });

  it('changes nothing when Square’s sales can’t be read, and says so', async () => {
    const h = harness();
    h.ours('73789'); h.square('73789'); h.elsewhere('73789');
    const run = await h.run();
    h.salesUnreadable('Square is down');
    expect((await h.service.latest('org', 'swap'))!.salesCheckError).toBe('Square is down');
    await expect(h.service.apply('org', 'swap', run.issues[0].id, 'delete_other', {}, 'staff')).rejects.toThrow('Couldn’t read Square’s sales');
    expect(h.squareDeletes).toEqual([]);
  });
});
