import { SquareError } from 'square';
import { SquarePosAdapterFactory } from './square.pos.adapter';
import type { PosItemSync } from './pos.adapter';

/** Plan 41 D7: many items written in batches of 500, at fresh versions. */
function harness(opts: { failBatch?: (n: number) => Error | null } = {}) {
  const upserts: { ids: string[]; versions: (bigint | undefined)[] }[] = [];
  let version = 7n;
  let batch = 0;
  const client = {
    catalog: {
      // Nothing in Square yet under these SKUs (Plan 47 looks before creating).
      search: async () => ({ objects: [], relatedObjects: [] }),
      batchGet: async ({ objectIds }: { objectIds: string[] }) => ({
        objects: objectIds.map((id) => ({ type: 'ITEM', id, version })),
      }),
      batchUpsert: async ({ batches }: { batches: { objects: { id: string; version?: bigint }[] }[] }) => {
        const objects = batches[0].objects;
        const err = opts.failBatch?.(batch++);
        if (err) throw err;
        upserts.push({ ids: objects.map((o) => o.id), versions: objects.map((o) => o.version) });
        return {
          idMappings: objects.flatMap((o, i) => (o.id.startsWith('#')
            ? [{ clientObjectId: `#item${i}`, objectId: `new-${upserts.length}-${i}` }, { clientObjectId: `#variation${i}`, objectId: `newv-${upserts.length}-${i}` }]
            : [])),
        };
      },
    },
    inventory: { batchCreateChanges: async () => ({}) },
  };
  const factory = new SquarePosAdapterFactory({ forOrg: async () => client } as never);
  return { adapter: factory.forOrg('org'), upserts, bump: () => { version += 1n; } };
}

const item = (sku: string, over: Partial<PosItemSync> = {}): PosItemSync => ({
  name: 'Skis', priceCents: 4500, sku, categoryId: 'cat', categoryName: 'Swap', ...over,
});
const versionMismatch = () => new SquareError({ statusCode: 400, body: { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'VERSION_MISMATCH' }] } });

describe('writing many items to Square at once', () => {
  it('sends 1,200 items as three batches and answers each one', async () => {
    const { adapter, upserts } = harness();
    const items = Array.from({ length: 1200 }, (_, i) => item(String(i)));
    const { results } = await (await adapter)!.upsertItems(items, 'loc', 1);
    expect(upserts.map((u) => u.ids.length)).toEqual([500, 500, 200]);
    expect(results.every((r) => 'posItemId' in r)).toBe(true);
  });

  it('writes an existing item at the version Square has now', async () => {
    const { adapter, upserts } = harness();
    const { results } = await (await adapter)!.upsertItems([item('1', { posItemId: 'sq-1', posVariationId: 'sv-1' })], 'loc', 1);
    expect(upserts[0]).toEqual({ ids: ['sq-1'], versions: [7n] });
    expect(results).toEqual([{ posItemId: 'sq-1', posVariationId: 'sv-1' }]);
  });

  it('tries a batch refused for a version mismatch once more', async () => {
    const { adapter, upserts } = harness({ failBatch: (n) => (n === 0 ? versionMismatch() : null) });
    const { results } = await (await adapter)!.upsertItems([item('1', { posItemId: 'sq-1', posVariationId: 'sv-1' })], 'loc', 1);
    expect(upserts).toHaveLength(1);
    expect(results[0]).toEqual({ posItemId: 'sq-1', posVariationId: 'sv-1' });
  });

  it('reports a batch that still fails on its items, and keeps the others', async () => {
    const { adapter } = harness({ failBatch: (n) => (n === 0 ? new Error('Square is down') : null) });
    const items = Array.from({ length: 600 }, (_, i) => item(String(i)));
    const { results } = await (await adapter)!.upsertItems(items, 'loc', 1);
    expect(results.slice(0, 500).every((r) => 'error' in r && r.error === 'Square is down')).toBe(true);
    expect(results.slice(500).every((r) => 'posItemId' in r)).toBe(true);
  });
});

describe('the variation Square prints on the receipt', () => {
  it('is named for the SKU, not "Regular"', async () => {
    const seen: unknown[] = [];
    const client = {
      catalog: {
      // Nothing in Square yet under these SKUs (Plan 47 looks before creating).
      search: async () => ({ objects: [], relatedObjects: [] }),
        batchGet: async () => ({ objects: [] }),
        batchUpsert: async ({ batches }: { batches: { objects: unknown[] }[] }) => {
          seen.push(...batches[0].objects);
          return { idMappings: [{ clientObjectId: '#item0', objectId: 'i' }, { clientObjectId: '#variation0', objectId: 'v' }] };
        },
      },
      inventory: { batchCreateChanges: async () => ({}) },
    };
    const adapter = await new SquarePosAdapterFactory({ forOrg: async () => client } as never).forOrg('org');
    await adapter!.upsertItems([item('73789')], 'loc', 1);
    const variation = (seen[0] as { itemData: { variations: { itemVariationData: { name: string; sku: string } }[] } }).itemData.variations[0];
    expect(variation.itemVariationData).toMatchObject({ name: '73789', sku: '73789' });
  });
});
