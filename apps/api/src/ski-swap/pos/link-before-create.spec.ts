import { SquarePosAdapterFactory } from './square.pos.adapter';
import type { PosItemSync } from './pos.adapter';

/**
 * Plan 47's safety net: an item Square already has under its SKU, in the
 * swap's category, is linked and updated rather than created a second time.
 * It covers what a claim can't: a crash mid-create, or an orphan from before.
 */

interface Existing { sku: string; itemId: string; variationId: string; archived?: boolean; category?: string }

function harness(existing: Existing[]) {
  const upserted: { id: string; version?: bigint }[] = [];
  const stocked: string[] = [];
  const created: string[] = [];
  let n = 0;
  const parent = (e: Existing) => ({
    type: 'ITEM', id: e.itemId, version: 41n,
    itemData: { name: `Item #${e.sku}`, isArchived: !!e.archived, categories: [{ id: e.category ?? 'cat' }], variations: [] },
  });
  const client = {
    catalog: {
      search: async ({ query }: { query: { setQuery: { attributeValues: string[] } } }) => {
        const hits = existing.filter((e) => query.setQuery.attributeValues.includes(e.sku));
        return {
          objects: hits.map((e) => ({ type: 'ITEM_VARIATION', id: e.variationId, itemVariationData: { sku: e.sku, itemId: e.itemId } })),
          relatedObjects: hits.map(parent),
        };
      },
      batchUpsert: async ({ batches }: { batches: { objects: { id: string; version?: bigint }[] }[] }) => {
        const mappings: { clientObjectId: string; objectId: string }[] = [];
        batches[0].objects.forEach((o, i) => {
          upserted.push({ id: o.id, version: o.version });
          if (o.id.startsWith('#')) {
            n++;
            created.push(`new-${n}`);
            mappings.push({ clientObjectId: `#item${i}`, objectId: `new-${n}` }, { clientObjectId: `#variation${i}`, objectId: `newv-${n}` });
          }
        });
        return { idMappings: mappings };
      },
      batchGet: async ({ objectIds }: { objectIds: string[] }) => ({ objects: objectIds.map((id) => ({ type: 'ITEM', id, version: 41n })) }),
      object: {
        get: async () => ({ object: { version: 41n } }),
        upsert: async ({ object }: { object: { id: string; version?: bigint } }) => {
          upserted.push({ id: object.id, version: object.version });
          return { catalogObject: { id: object.id.startsWith('#') ? 'new-single' : object.id }, idMappings: [] };
        },
      },
    },
    inventory: {
      batchCreateChanges: async ({ changes }: { changes: { adjustment?: { catalogObjectId: string }; physicalCount?: { catalogObjectId: string } }[] }) => {
        stocked.push(...changes.map((c) => (c.adjustment ?? c.physicalCount)!.catalogObjectId));
        return {};
      },
      batchGetCounts: async () => (async function* () { yield { catalogObjectId: 'linked', state: 'IN_STOCK', quantity: '1' }; })(),
    },
  };
  const adapter = new SquarePosAdapterFactory({ forOrg: async () => client } as never).forOrg('org');
  return { adapter, upserted, stocked, created };
}

const item = (sku: string, over: Partial<PosItemSync> = {}): PosItemSync => ({ name: `Item #${sku}`, priceCents: null, sku, categoryId: 'cat', categoryName: 'Ski Swap 2026', ...over });

describe('linking before creating (Plan 47)', () => {
  it('batch: links a ticket Square already has, creates the rest, and stocks only the new one', async () => {
    const h = harness([{ sku: '74820', itemId: 'SQ-74820', variationId: 'SV-74820' }]);
    const { ids } = await (await h.adapter)!.syncNewItems([item('74820'), item('74821')], 'loc', 1);
    expect(ids).toEqual([{ posItemId: 'SQ-74820', posVariationId: 'SV-74820' }, { posItemId: 'new-1', posVariationId: 'newv-1' }]);
    expect(h.upserted).toEqual([{ id: 'SQ-74820', version: 41n }, { id: '#item1', version: undefined }]);
    expect(h.stocked).toEqual(['newv-1']);
  });

  it('never links an archived item, or one in another category', async () => {
    const h = harness([
      { sku: '73789', itemId: 'OLD-2025', variationId: 'OV', archived: true },
      { sku: '73790', itemId: 'ELSEWHERE', variationId: 'EV', category: 'swag' },
    ]);
    const { ids } = await (await h.adapter)!.syncNewItems([item('73789'), item('73790')], 'loc', 1);
    expect(ids.map((x) => x.posItemId)).toEqual(['new-1', 'new-2']);
  });

  it('import and diagnostics: an item with no stored id links to the one Square has', async () => {
    const h = harness([{ sku: '74822', itemId: 'SQ-74822', variationId: 'SV-74822' }]);
    const { results } = await (await h.adapter)!.upsertItems([item('74822'), item('74823')], 'loc', 1);
    expect(results).toEqual([{ posItemId: 'SQ-74822', posVariationId: 'SV-74822' }, { posItemId: 'new-1', posVariationId: 'newv-1' }]);
    expect(h.stocked).toEqual(['newv-1']);
  });

  it('a single item with no stored id links too, and keeps the count it has', async () => {
    const h = harness([{ sku: '74819', itemId: 'SQ-74819', variationId: 'linked' }]);
    const r = await (await h.adapter)!.syncItem(item('74819'), 'loc', 1);
    expect(r).toMatchObject({ posItemId: 'SQ-74819', posVariationId: 'linked' });
    expect(h.upserted).toEqual([{ id: 'SQ-74819', version: 41n }]);
    expect(h.stocked).toEqual([]);
  });
});
