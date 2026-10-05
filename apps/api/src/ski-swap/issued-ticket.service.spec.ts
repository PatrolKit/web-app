import { IssuedTicketService, clashMessage } from './issued-ticket.service';

/**
 * Issuing tickets puts them on sale (Plan 38): a block becomes one unpriced,
 * accepted item per number, Square follows in batches, and returned ones are
 * taken back when nobody has touched them and they haven't sold.
 */

const SWAP = {
  id: 'swap-1', orgId: 'org-1', title: 'Fall Swap', squareCategoryId: 'cat-1', locationId: 'loc-1',
  allowLegacyCheckin: true, allowLegacyWeb: false,
};
const shop = (name: string) => ({ businessName: name, membership: { user: { firstName: null, lastName: null, email: null, phone: null } } });

type Row = Record<string, unknown> & { id: string; sku: string };

function harness(opts: {
  swap?: Record<string, unknown>;
  live?: Row[];
  pos?: Record<string, unknown> | null;
} = {}) {
  const swap = { ...SWAP, ...opts.swap };
  const live: Row[] = [...(opts.live ?? [])];
  const created: Row[] = [];
  const updates: { id: string; data: Record<string, unknown> }[] = [];
  const tombstoned: string[] = [];
  const prisma = {
    skiSwap: {
      findFirst: async () => swap,
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(swap, data),
    },
    sellerProfile: { findFirst: async () => ({ id: 'seller-1' }) },
    swapItem: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        // The push asks for accepted items with no Square id.
        if ('squareItemId' in where) return live.filter((r) => r.consignedAt && !r.squareItemId);
        return live;
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data });
        const row = live.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      updateMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        tombstoned.push(...where.id.in);
        return { count: where.id.in.length };
      },
    },
    $transaction: async (arg: unknown) => {
      if (Array.isArray(arg)) return arg;
      return (arg as (tx: unknown) => unknown)({
        swapItem: {
          createMany: async ({ data }: { data: Row[] }) => {
            created.push(...data);
            live.push(...data);
            return { count: data.length };
          },
        },
      });
    },
  };
  const pos = opts.pos === undefined ? null : opts.pos;
  const service = new IssuedTicketService(prisma as never, { forOrg: async () => pos } as never);
  return { service, created, updates, tombstoned, live, swap };
}

const ticket = (n: number, over: Record<string, unknown> = {}): Row => ({
  id: `t${n}`, sku: String(n), name: `Item #${n}`, priceCents: null, categoryId: null, description: null,
  consignedAt: new Date(), squareItemId: `sq-${n}`, squareVariationId: `var-${n}`, _count: { photos: 0 }, ...over,
});

describe('issuing a block', () => {
  it('creates one accepted, unpriced ticket per number, for the shop', async () => {
    const { service, created } = harness();
    await expect(service.issue('org-1', 'swap-1', 'seller-1', { startNumber: 67000, endNumber: 67002 }, 'staff-1'))
      .resolves.toEqual({ created: 3, startNumber: 67000, endNumber: 67002 });
    expect(created.map((r) => r.sku)).toEqual(['67000', '67001', '67002']);
    expect(created[0]).toMatchObject({
      name: 'Item #67000', liveSku: '67000', priceCents: null, sellerId: 'seller-1', originalQuantity: 1,
      hasPrintedTag: true, consignedBy: 'staff-1',
    });
    expect(created[0].consignedAt).toBeInstanceOf(Date);
  });

  it('refuses the whole block if any number is already an item, listing them', async () => {
    const { service, created } = harness({
      live: [{ id: 'a', sku: '67001', seller: shop('Stowe Sports') }, { id: 'b', sku: '67002', seller: shop('Stowe Sports') }],
    });
    await expect(service.issue('org-1', 'swap-1', 'seller-1', { startNumber: 67000, endNumber: 67005 }, 'staff-1'))
      .rejects.toThrow('67001 and 67002 (Stowe Sports) are already items. Nothing was issued.');
    expect(created).toHaveLength(0);
  });

  it('ignores numbers outside the block, and items that aren’t tickets', async () => {
    const { service } = harness({ live: [{ id: 'a', sku: '68000', seller: null }, { id: 'b', sku: 'FAL-A-0001', seller: null }] });
    await expect(service.issue('org-1', 'swap-1', 'seller-1', { startNumber: 67000, endNumber: 67005 }, 'staff-1'))
      .resolves.toMatchObject({ created: 6 });
  });

  it('is refused for a swap that takes no legacy tickets, or a backwards span', async () => {
    const off = harness({ swap: { allowLegacyCheckin: false, allowLegacyWeb: false } });
    await expect(off.service.issue('org-1', 'swap-1', 'seller-1', { startNumber: 1, endNumber: 2 }, 'staff-1'))
      .rejects.toThrow(/doesn’t take legacy tickets/);
    await expect(harness().service.issue('org-1', 'swap-1', 'seller-1', { startNumber: 5, endNumber: 2 }, 'staff-1'))
      .rejects.toThrow(/first number has to be below the last/);
  });
});

describe('putting issued tickets in Square', () => {
  function fakePos() {
    const batches: number[] = [];
    return {
      batches,
      syncNewItems: async (items: { sku: string }[]) => {
        batches.push(items.length);
        return { ids: items.map((i) => ({ posItemId: `sq-${i.sku}`, posVariationId: `var-${i.sku}` })), resolvedCategoryId: 'cat-2' };
      },
    };
  }

  it('sends them in batches of 1,000, storing each item’s ids, and keeps a recreated category', async () => {
    const pos = fakePos();
    const live = Array.from({ length: 1200 }, (_, i) => ticket(67000 + i, { squareItemId: null, squareVariationId: null }));
    const { service, swap } = harness({ live, pos });
    await service.push('org-1', 'swap-1');
    expect(pos.batches).toEqual([1000, 200]);
    expect(live.every((r) => r.squareItemId === `sq-${r.sku}` && r.squareVariationId === `var-${r.sku}`)).toBe(true);
    expect(swap.squareCategoryId).toBe('cat-2');
  });

  it('picks up only what isn’t in Square, so running it again resumes', async () => {
    const pos = fakePos();
    const live = [ticket(67000), ticket(67001, { squareItemId: null }), ticket(67002, { consignedAt: null, squareItemId: null })];
    const { service } = harness({ live, pos });
    await service.push('org-1', 'swap-1');
    expect(pos.batches).toEqual([1]);
  });

  it('does nothing without a location or Square', async () => {
    const pos = fakePos();
    await harness({ live: [ticket(67000, { squareItemId: null })], pos, swap: { locationId: '' } }).service.push('org-1', 'swap-1');
    await harness({ live: [ticket(67000, { squareItemId: null })], pos: null }).service.push('org-1', 'swap-1');
    expect(pos.batches).toEqual([]);
  });

  it('joins a push already running for the swap rather than starting another', async () => {
    const pos = fakePos();
    const { service } = harness({ live: [ticket(67000, { squareItemId: null })], pos });
    const first = service.push('org-1', 'swap-1');
    expect(service.push('org-1', 'swap-1')).toBe(first);
    await first;
  });
});

describe('taking back returned tickets', () => {
  function stockPos(inStock: string[] | 'unknown') {
    const deleted: string[] = [];
    return {
      deleted,
      getInventoryCounts: async () => {
        if (inStock === 'unknown') throw new Error('Square is down');
        return new Map(inStock.map((v) => [v, 1]));
      },
      deleteItems: async (ids: string[]) => { deleted.push(...ids); },
    };
  }

  it('removes untouched, unsold tickets in the span and keeps the rest, saying why', async () => {
    const pos = stockPos(['var-67000', 'var-67005']);
    const live = [
      ticket(67000),
      ticket(67001, { priceCents: 4500 }),
      ticket(67002, { categoryId: 'cat-skis', name: 'Skis' }),
      ticket(67003, { _count: { photos: 1 } }),
      ticket(67004), // sold: not in stock
      ticket(67005),
      ticket(67006, { squareItemId: null, squareVariationId: null }), // never reached Square
      ticket(67100), // outside the span
    ];
    const { service, tombstoned } = harness({ live, pos });
    const result = await service.remove('org-1', 'swap-1', 'seller-1', { startNumber: 67000, endNumber: 67010 });
    expect(result).toEqual({
      removed: 3,
      kept: [
        { sku: '67001', why: 'priced' },
        { sku: '67002', why: 'described' },
        { sku: '67003', why: 'has photos' },
        { sku: '67004', why: 'sold' },
      ],
    });
    expect(tombstoned).toEqual(['t67000', 't67005', 't67006']);
    expect(pos.deleted).toEqual(['sq-67000', 'sq-67005']);
  });

  it('keeps every ticket in Square when Square can’t say what sold', async () => {
    const pos = stockPos('unknown');
    const { service, tombstoned } = harness({ live: [ticket(67000), ticket(67001, { squareItemId: null, squareVariationId: null })], pos });
    const result = await service.remove('org-1', 'swap-1', 'seller-1', { startNumber: 67000, endNumber: 67001 });
    expect(result).toEqual({ removed: 1, kept: [{ sku: '67000', why: 'Square couldn’t say whether it sold' }] });
    expect(tombstoned).toEqual(['t67001']);
  });
});

describe('the overlap message', () => {
  it('groups by holder, and counts what it doesn’t show', () => {
    expect(clashMessage([{ n: 1, who: 'A' }])).toBe('1 (A) is already an item. Nothing was issued.');
    const many = Array.from({ length: 15 }, (_, i) => ({ n: i + 1, who: i < 2 ? 'Dana' : 'Stowe Sports' }));
    expect(clashMessage(many)).toBe(
      '1 and 2 (Dana); 3, 4, 5, 6, 7, 8, 9, 10, 11 and 12 (Stowe Sports) and 3 more are already items. Nothing was issued.',
    );
  });
});
