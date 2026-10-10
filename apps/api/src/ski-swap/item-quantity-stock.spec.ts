import { ItemService } from './item.service';

/**
 * An item edit moves Square's stock only by a change of quantity (10/10,
 * 75123): the Items form sends the quantity with every save, and setting
 * Square's stock to it put a sold item back on sale.
 */

const SWAP = { id: 'swap-1', orgId: 'org-1', skuPrefix: 'SS26', squareCategoryId: 'cat', title: 'Fall', locationId: 'loc' };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'item-1', sku: '75123', sellerId: null, orgId: 'org-1', swapId: 'swap-1', name: 'Scott Purple Poles', description: null,
  priceCents: null as number | null, originalQuantity: 1, squareItemId: 'sq-1', squareVariationId: 'v-1',
  donateProceeds: false, hasPrintedTag: false, categoryId: null, consignedAt: new Date(), consignedBy: null,
  deletedAt: null, updatedAt: new Date(), seller: null, photos: [], attributes: [], ...over,
});

function harness(opts: { existing: ReturnType<typeof row>; squareStock: number | null }) {
  const stockSets: [string, number][] = [];
  const pos = {
    getInventoryCounts: async (ids: string[]) => {
      if (opts.squareStock === null) throw new Error('Square is down');
      return new Map(ids.map((id) => [id, opts.squareStock!]));
    },
    setInventoryPhysicalCount: async (id: string, _loc: string, n: number) => { stockSets.push([id, n]); },
  };
  const prisma = {
    skiSwap: { findFirst: async () => SWAP },
    swapItem: {
      findFirst: async () => opts.existing,
      update: async (args: { data: Record<string, unknown> }) => ({ ...opts.existing, ...args.data }),
    },
  };
  const service = new ItemService(
    prisma as never,
    { forOrg: async () => pos } as never,
    { findOrThrow: async () => ({ id: 'seller-1' }) } as never,
    {} as never,
    { getCached: async () => null, save: async () => {} } as never,
    {} as never, {} as never, {} as never, {} as never,
    { describeItems: async () => new Map(), resolveAnswers: async () => ({ name: 'x', categoryId: null, rows: [] }) } as never,
  );
  const stub = service as unknown as Record<string, unknown>;
  stub.syncItemToPos = async () => 'skipped';
  stub.fetchInventoryMap = async () => null;
  stub.fetchDescriptions = async () => new Map();
  return { service, stockSets };
}

describe('an item edit and Square’s stock', () => {
  it('leaves a sold item sold when the form sends its unchanged quantity with a new price', async () => {
    const { service, stockSets } = harness({ existing: row(), squareStock: 0 });
    await service.patch('org-1', 'swap-1', 'item-1', { priceCents: 700, quantity: 1 });
    expect(stockSets).toEqual([]);
  });

  it('moves Square’s stock by a change of quantity, keeping what has sold', async () => {
    const { service, stockSets } = harness({ existing: row({ originalQuantity: 3 }), squareStock: 1 }); // 2 of 3 sold
    await service.patch('org-1', 'swap-1', 'item-1', { quantity: 5 });
    expect(stockSets).toEqual([['v-1', 3]]);
  });

  it('never goes below zero, and leaves Square alone when it can’t be read', async () => {
    const down = harness({ existing: row({ originalQuantity: 2 }), squareStock: 0 });
    await down.service.patch('org-1', 'swap-1', 'item-1', { quantity: 1 });
    expect(down.stockSets).toEqual([['v-1', 0]]);
    const unreadable = harness({ existing: row({ originalQuantity: 2 }), squareStock: null });
    await unreadable.service.patch('org-1', 'swap-1', 'item-1', { quantity: 3 });
    expect(unreadable.stockSets).toEqual([]);
  });
});
