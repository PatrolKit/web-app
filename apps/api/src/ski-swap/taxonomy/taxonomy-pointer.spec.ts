import { TaxonomyService, dedupeKeyFor } from './taxonomy.service';

/**
 * "Same details as" (Plan 44 D14, D15): Skis › Bindings included › Yes asks
 * the binding questions from Bindings › Type › Skis, answers store the shared
 * ids, the ski's name ignores them, and the pointer's rules hold.
 */

type Row = {
  id: string;
  kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE';
  orgId: string | null;
  parentId: string | null;
  label: string;
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
  sameDetailsAsId?: string | null;
};

const ORG = 'org-1';

function complete(r: Row) {
  return {
    iconKey: null, iconUrl: null, iconS3Key: null, iconBlob: null,
    status: 'APPROVED' as const, displayOrder: 0, retiredAt: null,
    input: null, nameSlot: null, unit: null, minValue: null, maxValue: null,
    step: null, allowFreeEntry: false, sameDetailsAsId: null, createdBy: null, approvedBy: null,
    approvedAt: null, suggestedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...r,
    dedupeKey: dedupeKeyFor(r.orgId, r.parentId, r.label),
  };
}

/** Skis with "Bindings included", and the Bindings category it points into. */
function tree(): Row[] {
  return [
    { id: 'skis', kind: 'CATEGORY', orgId: null, parentId: null, label: 'Skis', displayOrder: 10 },
    { id: 'ski-mfr', kind: 'ATTRIBUTE', orgId: null, parentId: 'skis', label: 'Manufacturer', input: 'SELECT', nameSlot: 10, displayOrder: 10 },
    { id: 'volkl', kind: 'VALUE', orgId: null, parentId: 'ski-mfr', label: 'Völkl', displayOrder: 10 },
    { id: 'len', kind: 'ATTRIBUTE', orgId: null, parentId: 'skis', label: 'Length', input: 'NUMBER', nameSlot: 30, unit: 'cm', minValue: 70, maxValue: 215, step: 1, displayOrder: 20 },
    { id: 'included', kind: 'ATTRIBUTE', orgId: null, parentId: 'skis', label: 'Bindings included', input: 'SELECT', nameSlot: null, displayOrder: 30 },
    { id: 'yes', kind: 'VALUE', orgId: null, parentId: 'included', label: 'Yes', displayOrder: 10, sameDetailsAsId: 'type-skis' },
    { id: 'no', kind: 'VALUE', orgId: null, parentId: 'included', label: 'No', displayOrder: 20 },

    { id: 'bindings', kind: 'CATEGORY', orgId: null, parentId: null, label: 'Bindings', displayOrder: 20 },
    { id: 'type', kind: 'ATTRIBUTE', orgId: null, parentId: 'bindings', label: 'Type', input: 'SELECT', nameSlot: 20, displayOrder: 10 },
    { id: 'type-skis', kind: 'VALUE', orgId: null, parentId: 'type', label: 'Skis', displayOrder: 10 },
    { id: 'b-mfr', kind: 'ATTRIBUTE', orgId: null, parentId: 'type-skis', label: 'Manufacturer', input: 'SELECT', nameSlot: 10, displayOrder: 10 },
    { id: 'marker', kind: 'VALUE', orgId: null, parentId: 'b-mfr', label: 'Marker', displayOrder: 10 },
    { id: 'look', kind: 'VALUE', orgId: null, parentId: 'b-mfr', label: 'Look', displayOrder: 20 },
    { id: 'marker-model', kind: 'ATTRIBUTE', orgId: null, parentId: 'marker', label: 'Model', input: 'SELECT', nameSlot: 15, allowFreeEntry: true, displayOrder: 10 },
    { id: 'griffon', kind: 'VALUE', orgId: null, parentId: 'marker-model', label: 'Griffon 13 ID', displayOrder: 10 },
    { id: 'din', kind: 'ATTRIBUTE', orgId: null, parentId: 'type-skis', label: 'Max DIN', input: 'NUMBER', nameSlot: 40, minValue: 2, maxValue: 18, step: 0.5, displayOrder: 20 },
  ];
}

function makeService(rows: Row[] = tree()) {
  const store = rows.map(complete);
  const entries: { nodeId: string; season: string }[] = [];
  const deleted: string[] = [];

  const matches = (r: Record<string, unknown>, where: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'OR') {
        if (!(v as Record<string, unknown>[]).some((w) => matches(r, w))) return false;
        continue;
      }
      const actual = r[k];
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
      findMany: async ({ where }: { where: Record<string, unknown> }) => store.filter((r) => matches(r, where ?? {})),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => store.find((r) => matches(r, where ?? {})) ?? null,
      findUnique: async ({ where }: { where: { id?: string; dedupeKey?: string } }) =>
        store.find((r) => (where.id ? r.id === where.id : r.dedupeKey === where.dedupeKey)) ?? null,
      create: async ({ data }: { data: Row }) => { const row = complete(data); store.push(row); return row; },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = store.find((r) => r.id === where.id)!;
        const { sameDetailsAs, ...rest } = data as { sameDetailsAs?: { connect?: { id: string }; disconnect?: true } };
        Object.assign(row, rest);
        if (sameDetailsAs?.connect) row.sameDetailsAsId = sameDetailsAs.connect.id;
        if (sameDetailsAs?.disconnect) row.sameDetailsAsId = null;
        return row;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = store.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        deleted.push(where.id);
        const i = store.findIndex((r) => r.id === where.id);
        return store.splice(i, 1)[0];
      },
      count: async ({ where }: { where: Record<string, unknown> }) => store.filter((r) => matches(r, where ?? {})).length,
    },
    bindingIndemnification: {
      findMany: async ({ where }: { where: { nodeId: string } }) => entries.filter((e) => e.nodeId === where.nodeId),
      deleteMany: async ({ where }: { where: { nodeId: string; season: { in: string[] } } }) => {
        let n = 0;
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].nodeId === where.nodeId && where.season.in.includes(entries[i].season)) { entries.splice(i, 1); n++; }
        }
        return { count: n };
      },
      updateMany: async ({ where, data }: { where: { nodeId: string }; data: { nodeId: string } }) => {
        const hit = entries.filter((e) => e.nodeId === where.nodeId);
        for (const e of hit) e.nodeId = data.nodeId;
        return { count: hit.length };
      },
      count: async () => 0,
    },
    $transaction: async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[]),
    skiSwapSettings: {
      findUnique: async () => ({ taxonomyVersion: 1, showUsBootSizes: false }),
      upsert: async () => ({}),
      updateMany: async () => ({}),
    },
    swapItemAttribute: {
      count: async () => 0, groupBy: async () => [], findMany: async () => [],
      deleteMany: async () => ({ count: 0 }), updateMany: async () => ({ count: 0 }),
    },
    swapItem: { groupBy: async () => [] },
    auditLog: { create: async () => ({}) },
  };
  const config = { get: () => '' };
  return { service: new TaxonomyService(prisma as never, config as never), store, entries, deleted };
}

describe('resolving a value that takes its details from another', () => {
  it('inlines the target\'s questions under the pointing value, and says whose they are', async () => {
    const { service } = makeService();
    const skis = (await service.resolve(ORG)).categories.find((c) => c.label === 'Skis')!;
    const included = skis.attributes.find((a) => a.label === 'Bindings included')!;
    const yes = included.values!.find((v) => v.label === 'Yes')!;
    expect(yes.sameDetailsAs).toEqual({ id: 'type-skis', category: 'Bindings' });
    expect(yes.attributes.map((a) => a.id)).toEqual(['b-mfr', 'din']);
    // Below a value, the maker list is deferred as it is in Bindings itself.
    expect(yes.attributes[0].valuesDeferred).toBe(true);
    expect(included.values!.find((v) => v.label === 'No')!.attributes).toEqual([]);
  });

  it('flags a binding maker\'s Model question as one whose answers can be looked up', async () => {
    const { service } = makeService();
    const bindings = (await service.resolve(ORG, { full: true })).categories.find((c) => c.label === 'Bindings')!;
    const marker = bindings.attributes[0].values![0].attributes[0].values!.find((v) => v.label === 'Marker')!;
    expect(marker.attributes[0]).toMatchObject({ label: 'Model', lookup: 'indemnification' });
    // The same node reached through the pointer carries the same flag.
    const skis = (await service.resolve(ORG, { full: true })).categories.find((c) => c.label === 'Skis')!;
    const yes = skis.attributes.find((a) => a.label === 'Bindings included')!.values![0];
    expect(yes.attributes[0].values!.find((v) => v.label === 'Marker')!.attributes[0].lookup).toBe('indemnification');
  });

  it('answers a deferred fetch on the pointing value with the target\'s questions', async () => {
    const { service } = makeService();
    const out = await service.children(ORG, 'yes');
    expect(out.attributes!.map((a) => a.id)).toEqual(['b-mfr', 'din']);
  });
});

describe('answering through the pointer', () => {
  it('stores the shared ids, and keeps the bindings out of the ski\'s name (D15)', async () => {
    const { service } = makeService();
    const out = await service.resolveAnswers(ORG, 'skis', [
      { attributeId: 'ski-mfr', valueId: 'volkl' },
      { attributeId: 'len', numberValue: 170 },
      { attributeId: 'included', valueId: 'yes' },
      { attributeId: 'b-mfr', valueId: 'marker' },
      { attributeId: 'marker-model', valueId: 'griffon' },
      { attributeId: 'din', numberValue: 13 },
    ]);
    expect(out.name).toBe('Völkl 170cm Skis');
    expect(out.rows).toEqual(expect.arrayContaining([
      { attributeId: 'b-mfr', valueId: 'marker', numberValue: null },
      { attributeId: 'marker-model', valueId: 'griffon', numberValue: null },
      { attributeId: 'din', valueId: null, numberValue: 13 },
    ]));
  });

  it('refuses the binding questions when Bindings included is not Yes', async () => {
    const { service } = makeService();
    await expect(
      service.resolveAnswers(ORG, 'skis', [{ attributeId: 'included', valueId: 'no' }, { attributeId: 'b-mfr', valueId: 'marker' }]),
    ).rejects.toThrow(/only applies once/);
    await expect(
      service.resolveAnswers(ORG, 'skis', [{ attributeId: 'b-mfr', valueId: 'marker' }]),
    ).rejects.toThrow(/only applies once/);
  });

  it('still names a binding item from the same questions', async () => {
    const { service } = makeService();
    const out = await service.resolveAnswers(ORG, 'bindings', [
      { attributeId: 'type', valueId: 'type-skis' },
      { attributeId: 'b-mfr', valueId: 'marker' },
      { attributeId: 'marker-model', valueId: 'griffon' },
    ]);
    expect(out.name).toBe('Marker Griffon 13 ID Skis Bindings');
  });
});

describe('setting the pointer', () => {
  it('is the platform\'s alone, on a shared answer, pointing at a shared answer', async () => {
    const { service, store } = makeService();
    await expect(service.patchNode(ORG, 'no', { sameDetailsAsId: 'type-skis' })).rejects.toThrow(/not editable here/);
    await expect(service.patchNode(null, 'no', { sameDetailsAsId: 'b-mfr' })).rejects.toThrow(/shared answer/);
    await expect(service.patchNode(null, 'no', { sameDetailsAsId: 'no' })).rejects.toThrow(/itself/);
    // Not through another pointer.
    await expect(service.patchNode(null, 'no', { sameDetailsAsId: 'yes' })).rejects.toThrow(/already/);
    await service.patchNode(null, 'no', { sameDetailsAsId: 'type-skis' });
    expect(store.find((r) => r.id === 'no')!.sameDetailsAsId).toBe('type-skis');
    await service.patchNode(null, 'no', { sameDetailsAsId: null });
    expect(store.find((r) => r.id === 'no')!.sameDetailsAsId).toBeNull();
  });

  it('refuses a target the value sits under, and a value with questions of its own', async () => {
    const { service } = makeService();
    // Griffon sits under Marker; pointing it there would loop.
    await expect(service.patchNode(null, 'griffon', { sameDetailsAsId: 'marker' })).rejects.toThrow(/under one another/);
    // Marker has a Model question of its own; it can't also borrow.
    await expect(service.patchNode(null, 'marker', { sameDetailsAsId: 'look' })).rejects.toThrow(/questions of its own/);
  });

  it('refuses a question under a value that takes its details from elsewhere', async () => {
    const { service } = makeService();
    await expect(
      service.createNode(null, { kind: 'ATTRIBUTE', parentId: 'yes', label: 'Brake width', input: 'NUMBER' }),
    ).rejects.toThrow(/takes its details from another/);
  });
});

describe('merging a binding model (D9)', () => {
  it('moves its seasons to the target, keeps the target\'s on a collision, and repoints pointers', async () => {
    const { service, store, entries, deleted } = makeService();
    store.push(complete({ id: 'griffon2', kind: 'VALUE', orgId: null, parentId: 'marker-model', label: 'GRIFFON 13 ID (dup)', displayOrder: 20 }));
    store.push(complete({ id: 'other-yes', kind: 'VALUE', orgId: null, parentId: 'included', label: 'Maybe', displayOrder: 30, sameDetailsAsId: 'griffon2' }));
    entries.push({ nodeId: 'griffon', season: '2025-26' }, { nodeId: 'griffon2', season: '2025-26' }, { nodeId: 'griffon2', season: '2024-25' });

    await service.merge(null, 'griffon2', 'griffon');

    expect(deleted).toEqual(['griffon2']);
    expect(entries.map((e) => `${e.nodeId}:${e.season}`).sort()).toEqual(['griffon:2024-25', 'griffon:2025-26']);
    expect(store.find((r) => r.id === 'other-yes')!.sameDetailsAsId).toBe('griffon');
  });
});
