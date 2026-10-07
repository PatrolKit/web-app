import { BadRequestException, ConflictException } from '@nestjs/common';
import { ItemCategorizeService, sameAnswers } from './item-categorize.service';
import { CategorizeItemsSchema } from '../contracts/ski-swap.contracts';

/** Batch set category (Plan 45), against a stub database. */

type Item = {
  id: string; orgId: string; swapId: string; liveSku: string; name: string; categoryId: string | null;
  priceCents: number; sellerId: string; squareItemId: string | null; deletedAt: Date | null;
  attributes: { attributeId: string; valueId: string | null; numberValue: number | null }[];
};

const LABELS: Record<string, string> = { skis: 'Skis', boots: 'Boots' };

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1', orgId: 'org', swapId: 'swap', liveSku: '67169', name: 'Item #67169', categoryId: null,
    priceCents: 4500, sellerId: 's1', squareItemId: 'sq-1', deletedAt: null, attributes: [], ...over,
  };
}

function harness(rows: Item[], opts: { invalid?: boolean; raceOn?: string } = {}) {
  const audits: { action: string; metadata: Record<string, unknown> }[] = [];
  const pushed: string[] = [];
  const byId = (id: string) => rows.find((r) => r.id === id)!;
  const tx = {
    swapItem: {
      updateMany: async ({ where, data }: { where: { id: string; categoryId: string | null }; data: Partial<Item> }) => {
        const r = byId(where.id);
        // A racing write lands between the read and this one.
        if (opts.raceOn === r.id) r.categoryId = 'boots';
        if (r.categoryId !== where.categoryId || r.deletedAt) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
    },
    swapItemAttribute: {
      createMany: async ({ data }: { data: { itemId: string; attributeId: string; valueId: string | null; numberValue: number | null }[] }) => {
        for (const d of data) byId(d.itemId).attributes.push({ attributeId: d.attributeId, valueId: d.valueId, numberValue: d.numberValue });
      },
      deleteMany: async ({ where }: { where: { itemId: string } }) => { byId(where.itemId).attributes = []; },
    },
  };
  const prisma = {
    ...tx,
    skiSwap: { findFirst: async () => ({ id: 'swap' }) },
    swapItem: {
      ...tx.swapItem,
      findMany: async ({ where }: { where: { liveSku: { in: string[] } } }) =>
        rows.filter((r) => where.liveSku.in.includes(r.liveSku) && !r.deletedAt).map((r) => ({
          ...r, category: r.categoryId ? { label: LABELS[r.categoryId] } : null, seller: null,
        })),
      findFirst: async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id && !x.deletedAt);
        return r ? { ...r, category: r.categoryId ? { label: LABELS[r.categoryId] } : null } : null;
      },
    },
    $transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    auditLog: { create: async ({ data }: { data: (typeof audits)[number] }) => { audits.push(data); return data; } },
  };
  const taxonomy = {
    resolveAnswers: async (_o: string, categoryId: string, inputs: { attributeId: string; valueId?: string; numberValue?: number }[]) => {
      if (opts.invalid) throw new BadRequestException('"Model" only applies once "Marker" is chosen');
      return {
        categoryId,
        categoryLabel: LABELS[categoryId],
        name: inputs.length ? 'Marker Skis' : 'Skis',
        rows: inputs.map((i) => ({ attributeId: i.attributeId, valueId: i.valueId ?? null, numberValue: i.numberValue ?? null })),
      };
    },
  };
  const items = { syncToPos: async (_o: string, _s: string, id: string) => { pushed.push(id); return 'synced'; } };
  const service = new ItemCategorizeService(prisma as never, taxonomy as never, items as never);
  const settle = () => new Promise((r) => setImmediate(r));
  return { service, audits, pushed, settle };
}

const PICK = { categoryId: 'skis', attributes: [{ attributeId: 'b-incl', valueId: 'yes' }, { attributeId: 'b-mfr', valueId: 'marker' }] };

describe('batch set category (Plan 45)', () => {
  it('sets the category and details, and nothing else', async () => {
    const row = item();
    const t = harness([row]);
    const { results } = await t.service.categorize('org', 'swap', { ...PICK, rename: false, skus: ['67169'] }, 'u1');
    await t.settle();
    expect(results).toEqual([{ sku: '67169', outcome: 'set', item: { id: 'i1', name: 'Item #67169', previousName: null, sellerName: null, categoryLabel: 'Skis' } }]);
    expect(row).toMatchObject({ categoryId: 'skis', name: 'Item #67169', priceCents: 4500, sellerId: 's1' });
    expect(row.attributes).toHaveLength(2);
    expect(t.pushed).toEqual([]);
  });

  it('renames when asked, keeps the old name, and pushes it to Square', async () => {
    const row = item();
    const t = harness([row, item({ id: 'i2', liveSku: '67170', categoryId: 'boots', name: 'Ski boots MP 26' })]);
    const { results } = await t.service.categorize('org', 'swap', { ...PICK, rename: true, skus: ['67169', '67170'] }, 'u1');
    await t.settle();
    expect(results[0].item).toMatchObject({ name: 'Marker Skis', previousName: 'Item #67169' });
    expect(row.name).toBe('Marker Skis');
    expect(results[1]).toMatchObject({ outcome: 'skipped', item: { name: 'Ski boots MP 26', categoryLabel: 'Boots' } });
    expect(t.pushed).toEqual(['i1']);
    expect(t.audits[0].metadata).toMatchObject({ rename: true, items: [{ id: 'i1', sku: '67169', previousName: 'Item #67169' }] });
  });

  it('skips an item with a category, answers not found, and answers a repeated SKU once', async () => {
    const t = harness([item({ categoryId: 'boots' })]);
    const { results } = await t.service.categorize('org', 'swap', { ...PICK, rename: false, skus: ['67169', '99999', '67169'] }, 'u1');
    expect(results.map((r) => [r.sku, r.outcome, r.item?.categoryLabel])).toEqual([['67169', 'skipped', 'Boots'], ['99999', 'not_found', undefined]]);
    expect(t.audits).toHaveLength(0);
  });

  it('never overwrites a category set while the batch was on its way', async () => {
    const row = item();
    const t = harness([row], { raceOn: 'i1' });
    const { results } = await t.service.categorize('org', 'swap', { ...PICK, rename: true, skus: ['67169'] }, 'u1');
    expect(results[0]).toMatchObject({ outcome: 'skipped', item: { categoryLabel: 'Boots', name: 'Item #67169' } });
    expect(row.attributes).toEqual([]);
  });

  it('fails the whole batch on a pick the tree no longer has', async () => {
    const t = harness([item()], { invalid: true });
    await expect(t.service.categorize('org', 'swap', { ...PICK, rename: false, skus: ['67169'] }, 'u1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('audits once per batch', async () => {
    const t = harness([item(), item({ id: 'i2', liveSku: '67170' })]);
    await t.service.categorize('org', 'swap', { ...PICK, rename: false, skus: ['67169', '67170'] }, 'u1');
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]).toMatchObject({ action: 'ski_swap.items.categorized' });
  });

  it('takes picks and numbers, never typed text', () => {
    const base = { categoryId: 'skis', skus: ['1'] };
    expect(CategorizeItemsSchema.safeParse({ ...base, attributes: [{ attributeId: 'a', valueId: 'v' }, { attributeId: 'din', numberValue: 10 }] }).success).toBe(true);
    expect(CategorizeItemsSchema.safeParse({ ...base, attributes: [{ attributeId: 'a', freeText: 'Markr' }] }).success).toBe(false);
    expect(CategorizeItemsSchema.safeParse({ ...base, skus: Array.from({ length: 26 }, (_, i) => String(i)) }).success).toBe(false);
  });
});

describe('undoing a row (D9)', () => {
  const set = (over: Partial<Item> = {}) => item({ categoryId: 'skis', attributes: [{ attributeId: 'b-incl', valueId: 'yes', numberValue: null }, { attributeId: 'b-mfr', valueId: 'marker', numberValue: null }], ...over });

  it('clears exactly what the session set, and leaves the name', async () => {
    const row = set();
    const t = harness([row]);
    const out = await t.service.uncategorize('org', 'swap', 'i1', PICK, 'u1');
    expect(row).toMatchObject({ categoryId: null, attributes: [], name: 'Item #67169' });
    expect(out).toEqual({ nameRestored: false, name: 'Item #67169' });
    expect(t.audits[0].action).toBe('ski_swap.item.category_cleared');
  });

  it('puts a renamed item\'s name back, and tells Square', async () => {
    const row = set({ name: 'Marker Skis' });
    const t = harness([row]);
    const out = await t.service.uncategorize('org', 'swap', 'i1', { ...PICK, rename: { from: 'Item #67169', to: 'Marker Skis' } }, 'u1');
    await t.settle();
    expect(out.nameRestored).toBe(true);
    expect(row.name).toBe('Item #67169');
    expect(t.pushed).toEqual(['i1']);
  });

  it('leaves a name changed since, and still clears the category', async () => {
    const row = set({ name: 'Völkl Mantra Skis' });
    const t = harness([row]);
    const out = await t.service.uncategorize('org', 'swap', 'i1', { ...PICK, rename: { from: 'Item #67169', to: 'Marker Skis' } }, 'u1');
    expect(out).toEqual({ nameRestored: false, name: 'Völkl Mantra Skis' });
    expect(row.categoryId).toBeNull();
  });

  it('refuses once the details changed since', async () => {
    const t = harness([set({ attributes: [{ attributeId: 'b-incl', valueId: 'yes', numberValue: null }] })]);
    const err = await t.service.uncategorize('org', 'swap', 'i1', PICK, 'u1').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'CHANGED_SINCE' });
  });

  it('compares answers in any order', () => {
    const a = [{ attributeId: 'x', valueId: '1', numberValue: null }, { attributeId: 'y', valueId: null, numberValue: 10 }];
    expect(sameAnswers(a, [...a].reverse())).toBe(true);
    expect(sameAnswers(a, a.slice(0, 1))).toBe(false);
  });
});
