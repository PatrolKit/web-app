import { ConflictException } from '@nestjs/common';
import { ItemService } from './item.service';

/**
 * A loose ticket scanned in at the counter.
 *
 * One stockpile, spent two ways: blocks issued to a business seller, which are
 * items from the moment they're issued (Plan 38), and single tickets given to
 * an individual at check-in. Both are `SwapItem.sku`, so the two ways can
 * collide, and nothing physical stops the wrong ticket coming off the wrong
 * pile.
 *
 * These cover what the server does about that. The rules are the same whether
 * the scan came from the staff iPad or the web items page; both arrive at
 * `createAtStation`.
 */

const SWAP = {
  id: 'swap-1', orgId: 'org-1', title: 'Ski Swap 2026',
  squareCategoryId: 'cat-1', locationId: 'loc-1', skuPrefix: 'SS26', skuCounter: 0,
};

const STATION = { id: 'station-1', code: 'A', bridgeDeviceId: null };

/** A Prisma unique-constraint failure, which is what a re-scan actually hits. */
function duplicateKeyError() {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
}

/**
 * @param holder whose item the scanned number already is, if anyone's
 * @param taken  whether the index refuses the insert: a race the check missed
 */
function harness(
  opts: {
    holder?: { sellerName: string | null } | null;
    taken?: boolean;
  } = {},
) {
  const rows: { id: string; sku: string; sellerId: string | null }[] = [];
  let n = 0;

  const prisma = {
    skiSwap: { findFirst: async () => SWAP },
    checkinStation: { findFirst: async () => STATION },
    swapItem: {
      create: async ({ data }: { data: { sku: string; sellerId: string | null } }) => {
        if (opts.taken) throw duplicateKeyError();
        const row = {
          id: `item-${++n}`, sku: data.sku, sellerId: data.sellerId,
          orgId: 'org-1', swapId: 'swap-1', name: '', description: null,
          priceCents: 0, originalQuantity: 1, squareItemId: null,
          squareVariationId: null, donateProceeds: false, hasPrintedTag: false,
          consignedAt: new Date(), consignedBy: null, updatedAt: new Date(),
          seller: null, photos: [],
        };
        rows.push(row);
        return row;
      },
      findFirst: async () => null,
      findUnique: async () => null,
      findUniqueOrThrow: async () => rows[0],
      update: async () => rows[0],
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
    { get: async () => ({ labelsPerItem: 1, requireConsignmentScan: false }) } as never,
    { takenBy: async () => opts.holder ?? null } as never,
    // These items are named rather than described (Plan 19), so the only
    // taxonomy call they reach is the one that fills in a response.
    { describeItems: async () => new Map() } as never,
  );
  (service as unknown as { syncItemToPos: () => Promise<string> }).syncItemToPos = async () => 'skipped';

  return { service, rows };
}

const ITEM = { fallbackName: 'Volkl Kendo 88 skis', priceCents: 24900, quantity: 1 };
const scan = (sku: string, sellerId?: string) => ({
  ...ITEM, sku, stationId: 'station-1', ...(sellerId ? { sellerId } : {}),
});

describe('scanning a ticket nobody holds', () => {
  it('takes the number as the SKU', async () => {
    const { service, rows } = harness();

    await service.createAtStation('org-1', 'swap-1', scan('67169'));

    expect(rows[0].sku).toBe('67169');
  });

  it('does not mint one of ours instead', async () => {
    // The whole point: the tag is already on the item, so the number on it has
    // to be the number we file it under.
    const { service, rows } = harness();

    await service.createAtStation('org-1', 'swap-1', scan('67169'));

    expect(rows[0].sku).not.toContain('SS26');
  });
});

describe('scanning a ticket issued to a business seller', () => {
  const held = { sellerName: 'Alpine Sports' };

  it('refuses it, saying whose it is, so staff can go and ask (Plan 38 D8)', async () => {
    // Taking it would hand a shop's number to somebody else. It's already an
    // item: issuing created it.
    const { service } = harness({ holder: held });

    const err = await service.createAtStation('org-1', 'swap-1', scan('67169')).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({ code: 'TICKET_TAKEN', message: 'Ticket 67169 belongs to Alpine Sports.' });
  });

  it('refuses the shop itself too: its ticket exists, to be filled in rather than added', async () => {
    const { service, rows } = harness({ holder: held });

    await expect(service.createAtStation('org-1', 'swap-1', scan('67169', 'shop-1'))).rejects.toThrow(/belongs to Alpine Sports/);
    expect(rows).toHaveLength(0);
  });
});

describe('scanning a ticket that is already on an item', () => {
  it('is refused rather than crashing', async () => {
    // A scanner double-reads, and two stations work the same pile. Before this
    // the unique index surfaced as a bare 500 with nothing a volunteer holding
    // an iPad could act on.
    const { service } = harness({ taken: true });

    await expect(service.createAtStation('org-1', 'swap-1', scan('67169')))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('names the ticket', async () => {
    const { service } = harness({ taken: true });

    await expect(service.createAtStation('org-1', 'swap-1', scan('67169')))
      .rejects.toThrow('Ticket 67169 is already on another item.');
  });

  it('says it differently for one of our own SKUs', async () => {
    // The same index catches a minted SKU sent twice, and calling that a
    // "ticket" would send staff looking for a piece of paper.
    const { service } = harness({ taken: true });

    await expect(service.createAtStation('org-1', 'swap-1', scan('SS26-A-0001')))
      .rejects.toThrow('SS26-A-0001 is already in use in this swap.');
  });
});
