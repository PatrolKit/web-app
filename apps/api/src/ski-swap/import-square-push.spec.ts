import { ItemService } from './item.service';

/**
 * A file import answers once its rows are written, and Square follows in the
 * background, in batches (a push per row kept a 1,000-row file waiting on
 * Square past the request's timeout).
 */

type Row = { id: string; sku: string; name: string; priceCents: number | null; consignedAt: Date | null; squareItemId: string | null; squareVariationId: string | null; description: null };

const ticket = (n: number, over: Partial<Row> = {}): Row => ({
  id: `t${n}`, sku: String(n), name: `Item #${n}`, priceCents: 4500, consignedAt: new Date(), description: null,
  squareItemId: `sq-${n}`, squareVariationId: `sv-${n}`, ...over,
});

function setup(rows: Row[], opts: { failSkus?: string[]; squareThrows?: boolean } = {}) {
  const order: string[] = [];
  const patched: { id: string; data: Record<string, unknown> }[] = [];
  const upserts: { posItemId?: string; sku: string }[][] = [];
  const stored: { id: string; data: Record<string, unknown> }[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const prisma = {
    skiSwap: {
      findFirst: async () => ({ id: 'swap-1', title: 'Ski Swap 2026', allowPrintWeb: true, allowLegacyWeb: true, locationId: 'loc', squareCategoryId: 'cat' }),
      update: async () => ({}),
    },
    swapItem: {
      findMany: async ({ where }: { where: { id: { in: string[] }; consignedAt?: unknown } }) =>
        where.id.in.map((id) => byId.get(id)!).filter((r) => r && (where.consignedAt === undefined || r.consignedAt !== null)),
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ where, data }),
    },
    $transaction: async (ops: { where: { id: string }; data: Record<string, unknown> }[]) => {
      for (const op of ops) stored.push({ id: op.where.id, data: op.data });
      return ops;
    },
  };
  const pos = {
    upsertItems: async (items: { posItemId?: string; sku: string }[]) => {
      if (opts.squareThrows) throw new Error('Square is down');
      order.push('upsert');
      upserts.push(items);
      return {
        results: items.map((i) => (opts.failSkus?.includes(i.sku)
          ? { error: 'refused' }
          : { posItemId: i.posItemId ?? `new-${i.sku}`, posVariationId: `var-${i.sku}` })),
        resolvedCategoryId: 'cat',
      };
    },
  };
  const issued = { push: async () => { order.push('issued push'); } };
  const checked = rows.map((r, i) => ({ line: i + 2, sku: r.sku, outcome: 'ok', itemId: r.id }));

  const service = new ItemService(
    prisma as never,
    { forOrg: async () => pos } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { checkImportRows: async () => checked } as never,
    {} as never,
    issued as never,
  );
  const stub = service as unknown as Record<string, unknown>;
  stub.patch = async (_o: string, _s: string, id: string, data: Record<string, unknown>) => {
    order.push('patch');
    patched.push({ id, data });
    return {};
  };
  /** The background push, finished: it runs on the swap's import lock. */
  const settled = () => (stub.withItemLock as (k: string, fn: () => Promise<void>) => Promise<void>)
    .call(service, 'import:swap-1', async () => undefined);

  const run = () => service.importItems('org-1', 'swap-1', 'seller-1',
    rows.map((r) => ({ sku: r.sku, name: 'Volkl Mantra 84', priceCents: 54900 })), { selfService: false });
  return { run, settled, order, patched, upserts, stored };
}

describe('Square after a file import', () => {
  it('writes every row without Square, then sends them in one batch', async () => {
    const t = setup([ticket(86828), ticket(86829)]);
    const results = await t.run();
    expect(results.map((r) => r.outcome)).toEqual(['updated', 'updated']);
    expect(t.patched.every((p) => p.data.deferPos === true)).toBe(true);
    await t.settled();
    expect(t.order).toEqual(['patch', 'patch', 'issued push', 'upsert']);
    expect(t.upserts).toHaveLength(1);
    expect(t.upserts[0].map((i) => i.posItemId)).toEqual(['sq-86828', 'sq-86829']);
  });

  it('sends a large file in batches of 500', async () => {
    const rows = Array.from({ length: 1192 }, (_, i) => ticket(86828 + i));
    const t = setup(rows);
    await t.run();
    await t.settled();
    expect(t.upserts.map((b) => b.length)).toEqual([500, 500, 192]);
    expect(t.stored).toHaveLength(1192);
  });

  it('stores Square’s ids for what landed and leaves what it refused', async () => {
    const t = setup([ticket(86828), ticket(86829, { squareItemId: null, squareVariationId: null })], { failSkus: ['86828'] });
    await t.run();
    await t.settled();
    expect(t.stored.map((s) => s.id)).toEqual(['t86829']);
    expect(t.stored[0].data).toMatchObject({ squareItemId: 'new-86829', squareVariationId: 'var-86829' });
  });

  it('keeps an item waiting to be accepted out of Square', async () => {
    const t = setup([ticket(86828), ticket(86829, { consignedAt: null })]);
    await t.run();
    await t.settled();
    expect(t.upserts[0].map((i) => i.sku)).toEqual(['86828']);
  });

  it('answers the upload even when Square is down', async () => {
    const t = setup([ticket(86828)], { squareThrows: true });
    const results = await t.run();
    expect(results[0].outcome).toBe('updated');
    await expect(t.settled()).resolves.toBeUndefined();
    expect(t.stored).toHaveLength(0);
  });
});
