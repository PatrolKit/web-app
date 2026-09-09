import { NotFoundException } from '@nestjs/common';
import { ItemService } from './item.service';

/**
 * Which items wait for a staff member, and what waiting actually stops.
 *
 * The rule these all turn on: the org toggle is read once, at check-in, and its
 * answer stored on the row as `consignedAt`. Nothing reads the setting again —
 * which is what makes flipping it mid-swap a non-event, and what makes "is this
 * sellable" answerable from the item alone.
 *
 * The invariant underneath is that an item is in Square exactly when it is
 * consigned. Every test below that counts Square pushes is checking that, not
 * checking a mock.
 */

interface Row {
  id: string;
  orgId: string;
  swapId: string;
  sellerId: string | null;
  name: string;
  description: string | null;
  sku: string;
  priceCents: number;
  originalQuantity: number;
  squareItemId: string | null;
  squareVariationId: string | null;
  donateProceeds: boolean;
  hasPrintedTag: boolean;
  consignedAt: Date | null;
  consignedBy: string | null;
  updatedAt: Date;
  seller: null;
  photos: never[];
}

const SWAP = {
  id: 'swap-1', orgId: 'org-1', title: 'Ski Swap 2026',
  squareCategoryId: 'cat-1', locationId: 'loc-1', skuPrefix: 'SS26', skuCounter: 0,
};

const STATION = { id: 'station-1', code: 'A', bridgeDeviceId: null };

/**
 * Enough Prisma to create an item and read it back.
 *
 * Rows live in a plain array so a test can look at what was written rather than
 * at what a mock was called with — `consignedAt` on the row is the thing under
 * test, and asserting on a call argument would pass just as happily if the
 * column were never set.
 */
function harness(opts: { requireConsignmentScan?: boolean } = {}) {
  const rows: Row[] = [];
  /** Mutable, so a test can flip the org toggle mid-swap the way an admin does. */
  const toggle = { requireConsignmentScan: opts.requireConsignmentScan ?? false };
  /** Item ids handed to Square, in order. */
  const pushed: string[] = [];
  let n = 0;

  const find = (where: Record<string, unknown>) =>
    rows.find((r) =>
      Object.entries(where).every(([k, v]) => (r as unknown as Record<string, unknown>)[k] === v),
    ) ?? null;

  const prisma = {
    skiSwap: { findFirst: async () => SWAP },
    checkinStation: { findFirst: async () => STATION },
    swapItem: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row: Row = {
          id: `item-${++n}`, orgId: 'org-1', swapId: 'swap-1', sellerId: null,
          name: '', description: null, sku: '', priceCents: 0, originalQuantity: 1,
          squareItemId: null, squareVariationId: null,
          donateProceeds: false, hasPrintedTag: false,
          consignedAt: null, consignedBy: null,
          updatedAt: new Date(), seller: null, photos: [],
          ...(data as Partial<Row>),
        };
        rows.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => find(where),
      findUnique: async ({ where }: { where: Record<string, unknown> }) => find(where),
      findUniqueOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
        const row = find(where);
        if (!row) throw new Error('not found');
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
    },
  };

  const pos = {
    // The one call that puts an item in the catalogue. Anything consigned goes
    // through here; anything waiting must not.
    createItem: async (_o: unknown, _s: unknown, item: { id: string }) => {
      pushed.push(item.id);
      return { squareItemId: 'sq-1', squareVariationId: 'sqv-1' };
    },
    getInventoryCounts: async () => new Map<string, number>(),
    setInventoryPhysicalCount: async () => {},
  };

  const service = new ItemService(
    prisma as never,
    { forOrg: async () => pos } as never,
    { findOrThrow: async () => ({ id: 'seller-1' }) } as never,
    {} as never,
    { getCached: async () => null, save: async () => {} } as never,
    { next: async () => `SS26-A-000${n + 1}` } as never,
    { enqueueItemTags: async () => {} } as never,
    { get: async () => ({ labelsPerItem: 1, ...toggle }) } as never,
    // No ticket blocks issued in these tests, so every number is unallocated.
    { holderOf: async () => null } as never,
  );

  // `syncItemToPos` is the private seam between an item and the catalogue, and
  // its Square-client plumbing is not what any of this is about. Replaced with
  // the one thing that matters here: whether it was reached.
  (service as unknown as { syncItemToPos: (o: string, s: unknown, i: { id: string }) => Promise<string> })
    .syncItemToPos = async (_o, _s, item) => { pushed.push(item.id); return 'synced'; };

  return { service, rows, pushed, toggle };
}

const ITEM = { name: 'Volkl Kendo 88 skis', priceCents: 24900, quantity: 1 };

describe('deciding at check-in whether an item waits', () => {
  it('consigns a self check-in item at once when the org has not asked for the scan', async () => {
    const { service, rows } = harness({ requireConsignmentScan: false });

    await service.createAtStation('org-1', 'swap-1', {
      ...ITEM, stationId: 'station-1', selfService: true,
    });

    expect(rows[0].consignedAt).not.toBeNull();
  });

  it('makes a self check-in item wait when the org has', async () => {
    const { service, rows } = harness({ requireConsignmentScan: true });

    await service.createAtStation('org-1', 'swap-1', {
      ...ITEM, stationId: 'station-1', selfService: true,
    });

    expect(rows[0].consignedAt).toBeNull();
  });

  it('never makes a staff-entered item wait, whatever the setting says', async () => {
    // A staff member typing an item in has already got it in their hands. A
    // second handling buys nothing, and would strand every item the web Items
    // page creates.
    const { service, rows } = harness({ requireConsignmentScan: true });

    await service.createAtStation('org-1', 'swap-1', { ...ITEM, stationId: 'station-1' });

    expect(rows[0].consignedAt).not.toBeNull();
  });

  it('never makes an item entered away from a station wait', async () => {
    // No station means a business seller at their own desk, listing stock they
    // will bring in. There is nobody standing at a table to scan it.
    const { service, rows } = harness({ requireConsignmentScan: true });

    await service.createAtStation('org-1', 'swap-1', { ...ITEM, selfService: true });

    expect(rows[0].consignedAt).not.toBeNull();
  });

  it('leaves the floor alone when the toggle goes on mid-swap', async () => {
    // The whole of D1, and the thing §4.1's copy warns about. This morning's
    // items were answered "no" at creation and stay on sale; only what is
    // checked in after the switch waits.
    const { service, rows, toggle } = harness({ requireConsignmentScan: false });
    const selfCheckIn = { ...ITEM, stationId: 'station-1', selfService: true };

    await service.createAtStation('org-1', 'swap-1', selfCheckIn);
    const stamped = rows[0].consignedAt;

    toggle.requireConsignmentScan = true;
    await service.createAtStation('org-1', 'swap-1', selfCheckIn);

    expect(rows[0].consignedAt).toBe(stamped);
    expect(rows[1].consignedAt).toBeNull();
  });

  it('leaves what is already waiting waiting when the toggle goes off', async () => {
    // The reverse, and equally uneventful: a seller standing beside a pile does
    // not have it silently accepted by an administrator changing their mind.
    // Staff scan it, which is the same action as before.
    const { service, rows, toggle } = harness({ requireConsignmentScan: true });
    const selfCheckIn = { ...ITEM, stationId: 'station-1', selfService: true };

    await service.createAtStation('org-1', 'swap-1', selfCheckIn);

    toggle.requireConsignmentScan = false;
    await service.createAtStation('org-1', 'swap-1', selfCheckIn);

    expect(rows[0].consignedAt).toBeNull();
    expect(rows[1].consignedAt).not.toBeNull();
  });
});

describe('what waiting stops', () => {
  it('keeps a waiting item out of the catalogue', async () => {
    // Not priced at zero, not flagged — absent. Being absent is the only thing
    // that actually stops a refused item ringing up at the register.
    const { service, pushed } = harness({ requireConsignmentScan: true });

    await service.create('org-1', 'swap-1', { ...ITEM, awaitsConsignment: true });

    expect(pushed).toEqual([]);
  });

  it('pushes an item that is consigned at creation', async () => {
    const { service, pushed, rows } = harness();

    await service.create('org-1', 'swap-1', { ...ITEM, awaitsConsignment: false });

    expect(pushed).toEqual([rows[0].id]);
  });

  it('still defers a station push, which is a different reason to wait', async () => {
    // `deferPos` is about the seller watching a spinner on venue wifi; the
    // batch goes up at finish. An item can be consigned and still not pushed
    // yet, and conflating the two would put every station item in Square one
    // round-trip at a time.
    const { service, pushed, rows } = harness();

    await service.create('org-1', 'swap-1', { ...ITEM, deferPos: true });

    expect(rows[0].consignedAt).not.toBeNull();
    expect(pushed).toEqual([]);
  });
});

describe('accepting an item', () => {
  async function waitingItem() {
    const h = harness({ requireConsignmentScan: true });
    await h.service.createAtStation('org-1', 'swap-1', {
      ...ITEM, stationId: 'station-1', selfService: true,
    });
    h.pushed.length = 0;
    return h;
  }

  it('stamps when it happened and who did it', async () => {
    const { service, rows } = await waitingItem();

    await service.consign('org-1', 'swap-1', rows[0].id, 'user-7');

    expect(rows[0].consignedAt).not.toBeNull();
    expect(rows[0].consignedBy).toBe('user-7');
  });

  it('puts it in the catalogue, which is the same event', async () => {
    const { service, rows, pushed } = await waitingItem();

    await service.consign('org-1', 'swap-1', rows[0].id, 'user-7');

    expect(pushed).toEqual([rows[0].id]);
  });

  it('takes a device id when the staff iPad did it', async () => {
    const { service, rows } = await waitingItem();

    await service.consign('org-1', 'swap-1', rows[0].id, 'device-3');

    expect(rows[0].consignedBy).toBe('device-3');
  });

  it('records nothing rather than a lie when the actor is unknown', async () => {
    const { service, rows } = await waitingItem();

    await service.consign('org-1', 'swap-1', rows[0].id, null);

    expect(rows[0].consignedAt).not.toBeNull();
    expect(rows[0].consignedBy).toBeNull();
  });

  it('accepts a second scan of the same tag without complaint', async () => {
    // A scanner double-reads a barcode constantly. The second read must not be
    // an error a staff member has to stop and think about.
    const { service, rows } = await waitingItem();

    await service.consign('org-1', 'swap-1', rows[0].id, 'user-7');
    const first = rows[0].consignedAt;
    await service.consign('org-1', 'swap-1', rows[0].id, 'user-9');

    expect(rows[0].consignedAt).toBe(first);
    expect(rows[0].consignedBy).toBe('user-7');
  });

  it('does not push a second time on that second scan', async () => {
    // A duplicate push would mint a second catalogue entry for one physical
    // item, which is how a swap ends up selling the same skis twice.
    const { service, rows, pushed } = await waitingItem();

    await service.consign('org-1', 'swap-1', rows[0].id, 'user-7');
    await service.consign('org-1', 'swap-1', rows[0].id, 'user-7');

    expect(pushed).toHaveLength(1);
  });

  it('is a no-op on an item that never had to wait', async () => {
    // With the toggle off everything is consigned at creation, so a stray
    // consign — a staff member scanning a pile at an org that does not require
    // it — changes nothing rather than re-stamping the time.
    const h = harness();
    await h.service.createAtStation('org-1', 'swap-1', { ...ITEM, stationId: 'station-1' });
    const stamped = h.rows[0].consignedAt;
    h.pushed.length = 0;

    await h.service.consign('org-1', 'swap-1', h.rows[0].id, 'user-7');

    expect(h.rows[0].consignedAt).toBe(stamped);
    expect(h.pushed).toEqual([]);
  });

  it('refuses an item that is not in this swap', async () => {
    const { service } = await waitingItem();

    await expect(service.consign('org-1', 'swap-1', 'item-elsewhere', 'user-7'))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('finding an item by the number on its tag', () => {
  async function withSku(sku: string) {
    const h = harness();
    await h.service.create('org-1', 'swap-1', { ...ITEM, sku });
    return h;
  }

  it('matches the tag exactly', async () => {
    const { service, rows } = await withSku('67169');

    const found = await service.findBySku('org-1', 'swap-1', '67169');

    expect(found.id).toBe(rows[0].id);
  });

  it('does not match a longer tag that merely starts the same', async () => {
    // `list` searches with `contains`, which is right for someone typing into a
    // box and wrong for a scanner: accepting 671690 when 67169 was scanned
    // means accepting the wrong pair of skis.
    const { service } = await withSku('671690');

    await expect(service.findBySku('org-1', 'swap-1', '67169'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('says which tag it could not find', async () => {
    const { service } = await withSku('67169');

    await expect(service.findBySku('org-1', 'swap-1', 'SS26-Q-0041'))
      .rejects.toThrow('No item in this swap has tag SS26-Q-0041.');
  });

  it('ignores whitespace a scanner appended', async () => {
    const { service, rows } = await withSku('67169');

    const found = await service.findBySku('org-1', 'swap-1', ' 67169\n');

    expect(found.id).toBe(rows[0].id);
  });
});
