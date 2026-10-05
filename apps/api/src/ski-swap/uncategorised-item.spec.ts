import { BadRequestException } from '@nestjs/common';
import { ItemService, uncategorisedName } from './item.service';

/**
 * Items nobody described (iOS Plan 20).
 *
 * Choosing what an item is became optional at the counter. Such an item is
 * called by its tag number, `Item #<sku>`, whoever adds it — staff on the iPad
 * or the web, a business seller entering their own, or a file with a blank name
 * column — and carries no answers.
 */

const SWAP = { id: 'swap-1', orgId: 'org-1', skuPrefix: 'SS26', squareCategoryId: 'cat', title: 'Fall', allowLegacyCheckin: true, allowLegacyWeb: true, allowPrintCheckin: true, allowPrintWeb: true };
const STATION = { id: 'station-1', code: 'A', bridgeDeviceId: null };

function harness() {
  const created: { name: string; sku: string; categoryId: string | null }[] = [];
  const prisma = {
    skiSwap: { findFirst: async () => SWAP },
    checkinStation: { findFirst: async () => STATION },
    swapItem: {
      create: async ({ data }: { data: { name: string; sku: string; categoryId?: string | null } }) => {
        const row = {
          id: `item-${created.length + 1}`, sku: data.sku, sellerId: null, orgId: 'org-1', swapId: 'swap-1',
          name: data.name, description: null, priceCents: 1000, originalQuantity: 1, squareItemId: null,
          squareVariationId: null, donateProceeds: false, hasPrintedTag: false, categoryId: data.categoryId ?? null,
          consignedAt: new Date(), consignedBy: null, updatedAt: new Date(), seller: null, photos: [],
        };
        created.push({ name: data.name, sku: data.sku, categoryId: data.categoryId ?? null });
        return row;
      },
      findFirst: async () => null,
      findUnique: async () => null,
      findUniqueOrThrow: async () => ({}),
      // The import path reads the row back; what it holds is not under test.
      findFirstOrThrow: async () => ({
        id: 'item-1', sku: '1', sellerId: null, orgId: 'org-1', swapId: 'swap-1', name: '', description: null,
        priceCents: 1000, originalQuantity: 1, squareItemId: null, squareVariationId: null, donateProceeds: false,
        hasPrintedTag: false, categoryId: null, consignedAt: new Date(), consignedBy: null, updatedAt: new Date(),
        seller: null, photos: [],
      }),
      update: async () => ({}),
    },
  };
  const service = new ItemService(
    prisma as never,
    { forOrg: async () => null } as never,
    { findOrThrow: async () => ({ id: 'seller-1' }) } as never,
    {} as never,
    { getCached: async () => null, save: async () => {} } as never,
    { next: async () => 'SS26-A-0001' } as never,
    { enqueueItemTags: async () => {} } as never,
    { get: async () => ({ requireConsignmentScan: false }) } as never,
    {
      takenBy: async () => null,
      checkImportRows: async (_s: string, _p: string, rows: unknown[]) => rows.map(() => ({ outcome: 'ok' })),
    } as never,
    {
      describeItems: async () => new Map(),
      resolveAnswers: async () => ({ name: 'Skis', categoryId: 'cat-skis', rows: [] }),
    } as never,
  );
  (service as unknown as { syncItemToPos: () => Promise<string> }).syncItemToPos = async () => 'skipped';
  return { service, created };
}

const base = { priceCents: 1000, quantity: 1, stationId: 'station-1' };

describe('an item with no category', () => {
  it('is called by the number the server gave it', async () => {
    const { service, created } = harness();
    await service.createAtStation('org-1', 'swap-1', base);
    expect(created[0]).toEqual({ name: 'Item #SS26-A-0001', sku: 'SS26-A-0001', categoryId: null });
  });

  it('is called by the number on its legacy ticket', async () => {
    const { service, created } = harness();
    await service.createAtStation('org-1', 'swap-1', { ...base, sku: '10042' });
    expect(created[0].name).toBe('Item #10042');
  });

  it('keeps the name a client printed on it', async () => {
    const { service, created } = harness();
    await service.createAtStation('org-1', 'swap-1', { ...base, sku: '10042', alreadyPrinted: true, name: 'Item #10042' });
    expect(created[0].name).toBe('Item #10042');
  });

  it('ignores a name sent for a tag that was not printed, and names it by number anyway', async () => {
    const { service, created } = harness();
    await service.createAtStation('org-1', 'swap-1', { ...base, sku: '10042', name: 'Something else' });
    expect(created[0].name).toBe('Item #10042');
  });

  it('is refused if it arrives with answers, which only a category can check', async () => {
    const { service } = harness();
    await expect(
      service.createAtStation('org-1', 'swap-1', { ...base, attributes: [{ attributeId: 'a', valueId: 'v' }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('is still named from its category when it has one', async () => {
    const { service, created } = harness();
    await service.createAtStation('org-1', 'swap-1', { ...base, categoryId: 'cat-skis' });
    expect(created[0]).toMatchObject({ name: 'Skis', categoryId: 'cat-skis' });
  });
});

describe('an imported file', () => {
  it('keeps a name from the file, and calls a blank one by its number', async () => {
    const { service, created } = harness();
    await service.importItems('org-1', 'swap-1', 'seller-1', [
      { sku: '10042', name: 'Rossignol boots', priceCents: 1000 },
      { sku: '10043', name: '  ', priceCents: 1000 },
      { sku: '10044', priceCents: 1000 },
    ], { selfService: false });
    expect(created.map((c) => c.name)).toEqual(['Rossignol boots', 'Item #10043', 'Item #10044']);
  });
});

it('writes the name the iPad prints on the tag', () => {
  expect(uncategorisedName('SS26-L-0001')).toBe('Item #SS26-L-0001');
});
