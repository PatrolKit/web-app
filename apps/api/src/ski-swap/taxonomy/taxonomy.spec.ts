import { TaxonomyService, dedupeKeyFor, normalizeLabel } from './taxonomy.service';

/**
 * The tree, against a fake Prisma.
 *
 * Rows in, behaviour out — the same shape as `consignment.spec.ts`. What is
 * being pinned here is the plan's load-bearing rules: the alternation, the
 * reachability gate, what free entry mints, and what the resolved document is
 * allowed to contain.
 */

type Row = {
  id: string;
  kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE';
  orgId: string | null;
  parentId: string | null;
  label: string;
  iconKey?: string | null;
  iconUrl?: string | null;
  status?: 'APPROVED' | 'PENDING';
  displayOrder?: number;
  retiredAt?: Date | null;
  input?: 'SELECT' | 'NUMBER' | null;
  nameSlot?: number | null;
  unit?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
  step?: number | null;
  allowFreeEntry?: boolean;
  dedupeKey?: string;
};

const ORG = 'org-1';

function complete(r: Row) {
  return {
    iconKey: null, iconUrl: null, iconS3Key: null, iconBlob: null,
    status: 'APPROVED' as const, displayOrder: 0, retiredAt: null,
    input: null, nameSlot: null, unit: null, minValue: null, maxValue: null,
    step: null, allowFreeEntry: false, createdBy: null, approvedBy: null,
    approvedAt: null, suggestedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...r,
    dedupeKey: r.dedupeKey ?? dedupeKeyFor(r.orgId, r.parentId, r.label),
  };
}

/**
 * A ski category with the brief's shape: a branching manufacturer, a bounded
 * number, a closed list, and one question that is captured but never named.
 */
function tree(): Row[] {
  return [
    { id: 'cat', kind: 'CATEGORY', orgId: null, parentId: null, label: 'Skis', iconKey: 'skis', displayOrder: 10 },
    { id: 'mfr', kind: 'ATTRIBUTE', orgId: null, parentId: 'cat', label: 'Manufacturer', input: 'SELECT', nameSlot: 10, allowFreeEntry: true, displayOrder: 10 },
    { id: 'head', kind: 'VALUE', orgId: null, parentId: 'mfr', label: 'Head', displayOrder: 10 },
    { id: 'volkl', kind: 'VALUE', orgId: null, parentId: 'mfr', label: 'Volkl', displayOrder: 20 },
    { id: 'model', kind: 'ATTRIBUTE', orgId: null, parentId: 'head', label: 'Model', input: 'SELECT', nameSlot: 20, allowFreeEntry: true, displayOrder: 10 },
    { id: 'kore', kind: 'VALUE', orgId: null, parentId: 'model', label: 'Kore', displayOrder: 10 },
    { id: 'len', kind: 'ATTRIBUTE', orgId: null, parentId: 'cat', label: 'Length', input: 'NUMBER', nameSlot: 30, unit: 'cm', minValue: 70, maxValue: 215, step: 1, displayOrder: 20 },
    { id: 'type', kind: 'ATTRIBUTE', orgId: null, parentId: 'cat', label: 'Type', input: 'SELECT', nameSlot: 40, displayOrder: 30 },
    { id: 'powder', kind: 'VALUE', orgId: null, parentId: 'type', label: 'Powder', displayOrder: 10 },
    { id: 'cond', kind: 'ATTRIBUTE', orgId: null, parentId: 'cat', label: 'Condition', input: 'SELECT', nameSlot: null, displayOrder: 40 },
    { id: 'good', kind: 'VALUE', orgId: null, parentId: 'cond', label: 'Good', displayOrder: 10 },
  ];
}

function makeService(rows: Row[] = tree()) {
  const store = rows.map(complete);
  const created: ReturnType<typeof complete>[] = [];

  const matches = (r: (typeof store)[number], where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as Record<string, unknown>[]).some((w) => matches(r, w))) return false;
        continue;
      }
      const actual = (r as unknown as Record<string, unknown>)[k];
      if (v !== null && typeof v === 'object' && 'in' in (v as object)) {
        if (!(v as { in: unknown[] }).in.includes(actual)) return false;
        continue;
      }
      if (actual !== v) return false;
    }
    return true;
  };

  const prisma = {
    taxonomyNode: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        store.filter((r) => matches(r, where ?? {})),
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        store.find((r) => matches(r, where ?? {})) ?? null,
      findUnique: async ({ where }: { where: { id?: string; dedupeKey?: string } }) =>
        store.find((r) => (where.id ? r.id === where.id : r.dedupeKey === where.dedupeKey)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = complete(data);
        store.push(row);
        created.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        store.filter((r) => matches(r, where ?? {})).length,
    },
    // The reorder writes go through a transaction; here they are already
    // promises against the same array, so awaiting them is the whole of it.
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    skiSwapSettings: {
      findUnique: async () => ({ taxonomyVersion: 7 }),
      upsert: async () => ({}),
      updateMany: async () => ({}),
    },
    swapItemAttribute: { count: async () => 0, groupBy: async () => [], findMany: async () => [] },
    swapItem: { groupBy: async () => [] },
    auditLog: { create: async () => ({}) },
  };

  // No APP_URL in the fake: icon URLs come back root-relative, which keeps the
  // assertions about paths rather than about a deployment's hostname.
  const config = { get: (k: string) => (k === 'app.appUrl' ? '' : undefined) };
  return { service: new TaxonomyService(prisma as never, config as never), store, created };
}

// ─── Keys ────────────────────────────────────────────────────────────────────

describe('dedupeKeyFor', () => {
  it('folds case and inner whitespace, which is what stops two Rossignols', () => {
    expect(dedupeKeyFor(ORG, 'mfr', 'Rossignol')).toBe(dedupeKeyFor(ORG, 'mfr', '  rossignol  '));
    expect(dedupeKeyFor(ORG, 'mfr', 'Helly Hansen')).toBe(dedupeKeyFor(ORG, 'mfr', 'Helly  Hansen'));
  });

  it('keeps the two scopes apart, so an org may hold its own copy of a name', () => {
    expect(dedupeKeyFor(null, 'mfr', 'Head')).not.toBe(dedupeKeyFor(ORG, 'mfr', 'Head'));
  });

  it('names a root, because MySQL treats two NULL parents as distinct', () => {
    expect(dedupeKeyFor(null, null, 'Skis')).toBe('global:root:skis');
  });

  it('normalizeLabel agrees with the key it is compared against', () => {
    expect(normalizeLabel('  Helly   Hansen ')).toBe('helly hansen');
  });
});

// ─── The resolved document ───────────────────────────────────────────────────

describe('resolve', () => {
  it('nests the tree and carries the version clients cache on', async () => {
    const { service } = makeService();
    const out = await service.resolve(ORG);

    expect(out.version).toBe(7);
    expect(out.categories).toHaveLength(1);
    const skis = out.categories[0];
    // Both halves: the key the web resolves against its bundle, and the URL a
    // native client fetches because it has no bundle (handoff Ask J).
    expect(skis.icon).toEqual({
      kind: 'registry',
      key: 'skis',
      url: '/api/v1/orgs/org-1/ski-swap/taxonomy/icons/skis.png',
    });
    expect(skis.attributes.map((a) => a.label)).toEqual(['Manufacturer', 'Length', 'Type', 'Condition']);
  });

  it('defers a value branch rather than inlining it', async () => {
    // §7.2: the model lists are what would bloat a phone's first fetch.
    const { service } = makeService();
    const skis = (await service.resolve(ORG)).categories[0];
    const head = skis.attributes[0].values!.find((v) => v.label === 'Head')!;
    expect(head.attributes[0].label).toBe('Model');
    expect(head.attributes[0].valuesDeferred).toBe(true);
    expect(head.attributes[0].values).toBeUndefined();
  });

  it('expands every branch inline under depth=full', async () => {
    // What an offline-first client asks for: one request that arrives complete,
    // because a lazily-loaded model list is a blank control at the counter.
    const { service } = makeService();
    const skis = (await service.resolve(ORG, { full: true })).categories[0];
    const head = skis.attributes[0].values!.find((v) => v.label === 'Head')!;
    const model = head.attributes[0];

    expect(model.label).toBe('Model');
    expect(model.valuesDeferred).toBeUndefined();
    expect(model.values!.map((v) => v.label)).toEqual(['Kore']);
  });

  it('leaves the default deferred, so the browser is unaffected', async () => {
    const { service } = makeService();
    const a = (await service.resolve(ORG)).categories[0].attributes[0];
    const b = (await service.resolve(ORG, { full: false })).categories[0].attributes[0];
    for (const attrs of [a, b]) {
      expect(attrs.values!.find((v) => v.label === 'Head')!.attributes[0].valuesDeferred).toBe(true);
    }
  });

  it('describes a number by its bounds rather than by values', async () => {
    const { service } = makeService();
    const len = (await service.resolve(ORG)).categories[0].attributes[1];
    expect(len).toMatchObject({ input: 'number', unit: 'cm', min: 70, max: 215, step: 1 });
    expect(len.values).toBeUndefined();
  });

  it('omits a pending value, and a retired one', async () => {
    // A pending value is usable by the item that minted it and offered to
    // nobody else (D7); a retired one stays readable and stops being picked (D4).
    const rows = tree();
    rows.push(
      { id: 'p', kind: 'VALUE', orgId: ORG, parentId: 'mfr', label: 'Rossignol', status: 'PENDING' },
      { id: 'r', kind: 'VALUE', orgId: null, parentId: 'mfr', label: 'Atomic', retiredAt: new Date() },
    );
    const { service } = makeService(rows);
    const labels = (await service.resolve(ORG)).categories[0].attributes[0].values!.map((v) => v.label);
    expect(labels).toEqual(['Head', 'Volkl']);
  });

  it("shows an org's own approved value beside the shared ones", async () => {
    const rows = tree();
    rows.push({ id: 'w', kind: 'VALUE', orgId: ORG, parentId: 'mfr', label: 'Wagner', displayOrder: 30 });
    const { service } = makeService(rows);
    const values = (await service.resolve(ORG)).categories[0].attributes[0].values!;
    expect(values.map((v) => v.label)).toEqual(['Head', 'Volkl', 'Wagner']);
    expect(values.find((v) => v.label === 'Wagner')!.scope).toBe('org');
  });

  it("never shows another org's value", async () => {
    const rows = tree();
    rows.push({ id: 'x', kind: 'VALUE', orgId: 'org-2', parentId: 'mfr', label: 'Someone else' });
    const { service } = makeService(rows);
    const labels = (await service.resolve(ORG)).categories[0].attributes[0].values!.map((v) => v.label);
    expect(labels).not.toContain('Someone else');
  });
});

// ─── Answering ───────────────────────────────────────────────────────────────

describe('resolveAnswers', () => {
  it('composes the brief’s example and returns a row per answer', async () => {
    const { service } = makeService();
    const out = await service.resolveAnswers(ORG, 'cat', [
      { attributeId: 'mfr', valueId: 'head' },
      { attributeId: 'model', valueId: 'kore' },
      { attributeId: 'len', numberValue: 112 },
      { attributeId: 'type', valueId: 'powder' },
    ]);
    expect(out.name).toBe('Head Kore 112cm Powder Skis');
    expect(out.rows).toHaveLength(4);
  });

  it('is the bare category when nothing is answered', async () => {
    const { service } = makeService();
    expect((await service.resolveAnswers(ORG, 'cat', [])).name).toBe('Skis');
  });

  it('captures an unnamed answer without putting it in the name', async () => {
    const { service } = makeService();
    const out = await service.resolveAnswers(ORG, 'cat', [{ attributeId: 'cond', valueId: 'good' }]);
    expect(out.name).toBe('Skis');
    expect(out.rows).toEqual([{ attributeId: 'cond', valueId: 'good', numberValue: null }]);
  });

  it('refuses a question that belongs to another category', async () => {
    const rows = tree();
    rows.push(
      { id: 'cat2', kind: 'CATEGORY', orgId: null, parentId: null, label: 'Jacket' },
      { id: 'size', kind: 'ATTRIBUTE', orgId: null, parentId: 'cat2', label: 'Size', input: 'SELECT' },
    );
    const { service } = makeService(rows);
    await expect(service.resolveAnswers(ORG, 'cat', [{ attributeId: 'size', valueId: 'x' }]))
      .rejects.toThrow(/does not belong to that category/);
  });

  it('refuses a branch question whose value was not chosen', async () => {
    // The gate: an item must not say "Model: Kore" while its manufacturer is
    // something else. The form cannot produce it and the name would be nonsense.
    const { service } = makeService();
    await expect(service.resolveAnswers(ORG, 'cat', [{ attributeId: 'model', valueId: 'kore' }]))
      .rejects.toThrow(/only applies once "Head" is chosen/);
  });

  it('accepts a branch question once its value is chosen', async () => {
    const { service } = makeService();
    const out = await service.resolveAnswers(ORG, 'cat', [
      { attributeId: 'mfr', valueId: 'head' },
      { attributeId: 'model', valueId: 'kore' },
    ]);
    expect(out.name).toBe('Head Kore Skis');
  });

  it('refuses a value that answers a different question', async () => {
    const { service } = makeService();
    await expect(service.resolveAnswers(ORG, 'cat', [{ attributeId: 'type', valueId: 'head' }]))
      .rejects.toThrow(/not an answer to "Type"/);
  });

  it('refuses a number outside its bounds, and off its step', async () => {
    const { service } = makeService();
    await expect(service.resolveAnswers(ORG, 'cat', [{ attributeId: 'len', numberValue: 900 }]))
      .rejects.toThrow(/cannot be above 215/);
    await expect(service.resolveAnswers(ORG, 'cat', [{ attributeId: 'len', numberValue: 50 }]))
      .rejects.toThrow(/cannot be below 70/);
    await expect(service.resolveAnswers(ORG, 'cat', [{ attributeId: 'len', numberValue: 112.5 }]))
      .rejects.toThrow(/steps of 1/);
  });

  it('refuses two answers to one question', async () => {
    const { service } = makeService();
    await expect(
      service.resolveAnswers(ORG, 'cat', [
        { attributeId: 'type', valueId: 'powder' },
        { attributeId: 'type', valueId: 'powder' },
      ]),
    ).rejects.toThrow(/answered twice/);
  });

  it('refuses an answer carrying two kinds of value at once', async () => {
    const { service } = makeService();
    await expect(
      service.resolveAnswers(ORG, 'cat', [{ attributeId: 'mfr', valueId: 'head', freeText: 'Volkl' }]),
    ).rejects.toThrow(/one value, not several/);
  });

  it('ignores a control the seller cleared', async () => {
    const { service } = makeService();
    const out = await service.resolveAnswers(ORG, 'cat', [{ attributeId: 'type' }]);
    expect(out.rows).toEqual([]);
    expect(out.name).toBe('Skis');
  });

  it('refuses a retired category outright', async () => {
    const rows = tree();
    rows[0].retiredAt = new Date();
    const { service } = makeService(rows);
    await expect(service.resolveAnswers(ORG, 'cat', [])).rejects.toThrow(/no longer available/);
  });
});

// ─── Free entry ──────────────────────────────────────────────────────────────

describe('free entry', () => {
  it('mints a pending org value and uses it in the name immediately', async () => {
    // D7: a seller with a queue behind them cannot wait for an approval.
    const { service, created } = makeService();
    const out = await service.resolveAnswers(ORG, 'cat', [
      { attributeId: 'mfr', freeText: 'Rossignol' },
    ]);
    expect(out.name).toBe('Rossignol Skis');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ label: 'Rossignol', orgId: ORG, status: 'PENDING', kind: 'VALUE' });
  });

  it('refuses free entry on a closed list', async () => {
    const { service } = makeService();
    await expect(service.resolveAnswers(ORG, 'cat', [{ attributeId: 'cond', freeText: 'Thrashed' }]))
      .rejects.toThrow(/takes one of the listed answers/);
  });

  it('reuses a shared value rather than minting a duplicate of it', async () => {
    // §8.1: typing what is already on the list must not fork it.
    const { service, created } = makeService();
    const out = await service.resolveAnswers(ORG, 'cat', [{ attributeId: 'mfr', freeText: '  head ' }]);
    expect(out.rows[0].valueId).toBe('head');
    expect(created).toHaveLength(0);
  });

  it('reuses the pending value a previous seller already minted', async () => {
    const rows = tree();
    rows.push({ id: 'pend', kind: 'VALUE', orgId: ORG, parentId: 'mfr', label: 'Rossignol', status: 'PENDING' });
    const { service, created } = makeService(rows);
    const out = await service.resolveAnswers(ORG, 'cat', [{ attributeId: 'mfr', freeText: 'rossignol' }]);
    expect(out.rows[0].valueId).toBe('pend');
    expect(created).toHaveLength(0);
  });
});

// ─── Reordering ──────────────────────────────────────────────────────────────

describe('reorder', () => {
  /** The four values under Skis › Manufacturer in the fixture, plus one more. */
  function withFourBrands() {
    const rows = tree();
    rows.push({ id: 'atomic', kind: 'VALUE', orgId: null, parentId: 'mfr', label: 'Atomic', displayOrder: 30 });
    return makeService(rows);
  }

  it('renumbers a whole group to 10, 20, 30…', async () => {
    const { service, store } = withFourBrands();
    const out = await service.reorder(null, ['atomic', 'volkl', 'head']);

    const order = (id: string) => store.find((n) => n.id === id)!.displayOrder;
    expect([order('atomic'), order('volkl'), order('head')]).toEqual([10, 20, 30]);
    // Two, not three: reversing three items leaves the middle one on the number
    // it already had, and a row that does not need writing is not written.
    expect(out.moved).toBe(2);
  });

  it('writes only the rows that actually move', async () => {
    // head=10, volkl=20, atomic=30 already. Naming them in that order is a no-op.
    const { service } = withFourBrands();
    expect((await service.reorder(null, ['head', 'volkl', 'atomic'])).moved).toBe(0);
  });

  it('refuses a partial order, which would collide with the rows left out', async () => {
    const { service } = withFourBrands();
    await expect(service.reorder(null, ['volkl', 'head'])).rejects.toThrow(/every sibling/);
  });

  it('refuses nodes that are not siblings', async () => {
    const { service } = withFourBrands();
    await expect(service.reorder(null, ['head', 'powder'])).rejects.toThrow(/not siblings/);
  });

  it('refuses an id that does not exist', async () => {
    const { service } = withFourBrands();
    await expect(service.reorder(null, ['head', 'volkl', 'nope'])).rejects.toThrow(/do not exist/);
  });
});

// ─── Placement ───────────────────────────────────────────────────────────────

describe('createNode', () => {
  it('refuses an answer under a number question', async () => {
    // D9: a continuum has no children, so it can never become a branch point.
    const { service } = makeService();
    await expect(service.createNode(null, { kind: 'VALUE', parentId: 'len', label: '112' }))
      .rejects.toThrow(/no listed answers/);
  });

  it('refuses an answer that is not under a question', async () => {
    const { service } = makeService();
    await expect(service.createNode(null, { kind: 'VALUE', parentId: 'cat', label: 'Nope' }))
      .rejects.toThrow(/belongs under a question/);
  });

  it('refuses a category with a parent, and a question without one', async () => {
    const { service } = makeService();
    await expect(service.createNode(null, { kind: 'CATEGORY', parentId: 'cat', label: 'Nested' }))
      .rejects.toThrow(/takes no parent/);
    await expect(service.createNode(null, { kind: 'ATTRIBUTE', label: 'Orphan', input: 'SELECT' }))
      .rejects.toThrow(/Only a category may have no parent/);
  });

  it('refuses a question with no input kind', async () => {
    const { service } = makeService();
    await expect(service.createNode(null, { kind: 'ATTRIBUTE', parentId: 'cat', label: 'Nameless' }))
      .rejects.toThrow(/needs an input kind/);
  });

  it('refuses a duplicate label in the same place', async () => {
    const { service } = makeService();
    await expect(service.createNode(null, { kind: 'VALUE', parentId: 'mfr', label: 'head' }))
      .rejects.toThrow(/already here/);
  });

  it('allows an org its own value beside a shared one of the same name', async () => {
    // The two scopes are separate keys, which is what lets an overlay exist.
    const { service, created } = makeService();
    await service.createNode(ORG, { kind: 'VALUE', parentId: 'mfr', label: 'Head' });
    expect(created[0]).toMatchObject({ label: 'Head', orgId: ORG });
  });
});
