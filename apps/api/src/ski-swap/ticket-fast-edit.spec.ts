import { ConflictException } from '@nestjs/common';
import { ItemService } from './item.service';
import { PatchItemSchema } from '../contracts/ski-swap.contracts';

/**
 * The legacy ticket fast edit (Plan 37): a list of the tickets still waiting
 * for a price, and a price that's only ever set on one of them, never over a
 * price somebody set meanwhile.
 */

const SWAP = { id: 'swap-1', orgId: 'org-1', skuPrefix: 'SS26', squareCategoryId: 'cat', title: 'Fall', locationId: null };

const row = (over: Record<string, unknown> = {}) => ({
  id: 'item-1', sku: '67169', sellerId: null, orgId: 'org-1', swapId: 'swap-1', name: 'Item #67169', description: null,
  priceCents: null as number | null, originalQuantity: 1, squareItemId: null, squareVariationId: null,
  donateProceeds: false, hasPrintedTag: false, categoryId: null, consignedAt: null, consignedBy: null,
  deletedAt: null, updatedAt: new Date(), seller: null, photos: [], attributes: [], ...over,
});

function harness(opts: { existing?: ReturnType<typeof row>; list?: ReturnType<typeof row>[]; pricedMeanwhile?: number } = {}) {
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  let listWhere: Record<string, unknown> | null = null;
  const prisma = {
    skiSwap: { findFirst: async () => SWAP },
    swapItem: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        listWhere = where;
        return opts.list ?? [];
      },
      // The patch's own read first; after a refused write, the price it lost to.
      findFirst: async ({ select }: { select?: unknown }) =>
        select ? { priceCents: opts.pricedMeanwhile ?? null } : opts.existing ?? null,
      update: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        if (opts.pricedMeanwhile !== undefined && 'priceCents' in args.where) {
          throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
        }
        return { ...opts.existing, ...args.data };
      },
    },
  };
  const service = new ItemService(
    prisma as never,
    { forOrg: async () => null } as never,
    { findOrThrow: async () => ({ id: 'seller-1' }) } as never,
    {} as never,
    { getCached: async () => null, save: async () => {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      describeItems: async () => new Map(),
      resolveAnswers: async () => ({ name: 'Red Rossignol Skis', categoryId: 'cat-skis', rows: [] }),
    } as never,
  );
  const stub = service as unknown as Record<string, unknown>;
  stub.syncItemToPos = async () => 'skipped';
  stub.fetchInventoryMap = async () => null;
  stub.fetchDescriptions = async () => new Map();
  return { service, updates, listWhere: () => listWhere };
}

describe('the unpriced ticket list', () => {
  it('lists only tickets, in number order, saying which still have a stand-in name', async () => {
    const { service, listWhere } = harness({
      list: [
        row({ id: 'b', sku: '1200', name: 'Rossignol Skis' }),
        row({ id: 'a', sku: '987', name: 'Item #987' }),
        row({ id: 'x', sku: 'SS26-A-0001', name: 'Item #SS26-A-0001' }),
      ],
    });
    const list = await service.unpricedTickets('org-1', 'swap-1');
    expect(list.map((t) => t.sku)).toEqual(['987', '1200']);
    expect(list[0]).toMatchObject({ placeholderName: true, sellerName: null });
    expect(list[1]).toMatchObject({ placeholderName: false, name: 'Rossignol Skis' });
    expect(listWhere()).toMatchObject({ swapId: 'swap-1', deletedAt: null, priceCents: null });
  });
});

describe('a price set only if there is none', () => {
  it('is accepted on the wire as true, and only true', () => {
    expect(PatchItemSchema.safeParse({ priceCents: 4500, ifUnpriced: true }).success).toBe(true);
    expect(PatchItemSchema.safeParse({ priceCents: 4500, ifUnpriced: false }).success).toBe(false);
  });

  it('prices an unpriced ticket, requiring no price in the write itself', async () => {
    const { service, updates } = harness({ existing: row() });
    await service.patch('org-1', 'swap-1', 'item-1', { priceCents: 4500, ifUnpriced: true });
    expect(updates[0].where).toEqual({ id: 'item-1', priceCents: null });
    expect(updates[0].data).toMatchObject({ priceCents: 4500 });
  });

  it('refuses a ticket that already has a price, saying what', async () => {
    const { service, updates } = harness({ existing: row({ priceCents: 4500 }) });
    const err = await service.patch('org-1', 'swap-1', 'item-1', { priceCents: 5000, ifUnpriced: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({ code: 'TICKET_PRICED', message: '67169 already has a price ($45.00).' });
    expect(updates).toHaveLength(0);
  });

  it('refuses one priced between the check and the write', async () => {
    const { service } = harness({ existing: row(), pricedMeanwhile: 3000 });
    const err = await service.patch('org-1', 'swap-1', 'item-1', { priceCents: 5000, ifUnpriced: true }).catch((e) => e);
    expect(err.getResponse()).toEqual({ code: 'TICKET_PRICED', message: '67169 already has a price ($30.00).' });
  });

  it('keeps the typed name over the derived one, with the answers it picked', async () => {
    const { service, updates } = harness({ existing: row() });
    await service.patch('org-1', 'swap-1', 'item-1', {
      priceCents: 4500, ifUnpriced: true, categoryId: 'cat-skis', attributes: [], name: 'Rossignol Red Skis 170 demo',
    });
    expect(updates[0].data).toMatchObject({ name: 'Rossignol Red Skis 170 demo', categoryId: 'cat-skis', priceCents: 4500 });
  });

  it('leaves a patch without it as it was: no price required to write', async () => {
    const { service, updates } = harness({ existing: row({ priceCents: 4500 }) });
    await service.patch('org-1', 'swap-1', 'item-1', { priceCents: 5000 });
    expect(updates[0].where).toEqual({ id: 'item-1' });
  });
});
