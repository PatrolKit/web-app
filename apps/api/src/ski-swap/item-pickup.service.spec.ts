import { lastValueFrom, of } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { DEVICE_ROLES_KEY } from '../common/decorators/require-device-role.decorator';
import { DeviceStockInterceptor, deviceRequest } from './device-stock.interceptor';
import { ItemController } from './item.controller';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ItemPickupService, type PickupActor } from './item-pickup.service';

/** Sellers picking up their unsold items (Plan 43), against a stub database and Square. */

type Row = {
  id: string; orgId: string; swapId: string; sku: string; sellerId: string | null; originalQuantity: number;
  consignedAt: Date | null; deletedAt: Date | null; squareItemId: string | null; squareVariationId: string | null;
  pickedUpAt: Date | null; pickedUpBy: string | null; pickedUpByName: string | null; pickedUpUnits: number | null;
  seller: { businessName: string | null; membership: { user: { firstName: string; lastName: string; email: null; phone: null } } } | null;
};

const shop = (name: string) => ({ businessName: name, membership: { user: { firstName: '', lastName: '', email: null, phone: null } } });
const ACCEPTED = new Date('2026-10-05T15:00:00Z');

function item(over: Partial<Row> = {}): Row {
  return {
    id: 'i1', orgId: 'org', swapId: 'swap', sku: '67169', sellerId: 's1', originalQuantity: 1,
    consignedAt: ACCEPTED, deletedAt: null, squareItemId: 'sq-1', squareVariationId: 'sv-1',
    pickedUpAt: null, pickedUpBy: null, pickedUpByName: null, pickedUpUnits: null, seller: shop('Little Mountain'), ...over,
  };
}

function harness(rows: Row[], opts: { stock?: Map<string, number> | 'throws'; deleteFails?: boolean } = {}) {
  const audits: { action: string; actorType: string; actorId: string; metadata: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const pushed: string[] = [];
  const cache = new Map<string, unknown>();
  const byId = () => new Map(rows.map((r) => [r.id, r]));
  const prisma = {
    skiSwap: { findFirst: async () => ({ id: 'swap', locationId: 'loc' }) },
    swapItem: {
      findFirst: async ({ where }: { where: { id?: string; liveSku?: string } }) =>
        rows.find((r) => (where.id ? r.id === where.id : r.sku === where.liveSku) && !r.deletedAt) ?? null,
      updateMany: async ({ where, data }: { where: { id: string; pickedUpAt: null }; data: Partial<Row> }) => {
        const r = byId().get(where.id);
        if (!r || r.pickedUpAt) return { count: 0 };
        Object.assign(r, data);
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => Object.assign(byId().get(where.id)!, data),
      findMany: async () => rows.filter((r) => !r.pickedUpAt && r.consignedAt && !r.deletedAt),
    },
    auditLog: { create: async ({ data }: { data: (typeof audits)[number] }) => { audits.push(data); return data; } },
    device: { findUnique: async () => ({ name: 'iPad 2' }) },
    user: { findUnique: async () => ({ firstName: 'Pat', lastName: 'Lee', email: null, phone: null }) },
    sellerProfile: { findFirst: async () => shop('Geigers') },
  };
  const pos = {
    getInventoryCounts: async () => {
      if (opts.stock === 'throws') throw new Error('Square is down');
      return opts.stock ?? new Map([['sv-1', 1]]);
    },
    deleteItem: async (id: string) => {
      if (opts.deleteFails) throw new Error('Square refused');
      deleted.push(id);
    },
  };
  const items = {
    get: async (_o: string, _s: string, id: string) => ({ id, pickedUpAt: byId().get(id)?.pickedUpAt?.toISOString() ?? null, pickedUpBy: byId().get(id)?.pickedUpByName ?? null }),
    syncToPos: async (_o: string, _s: string, id: string) => { pushed.push(id); return 'synced'; },
  };
  const idempotency = {
    getCached: async (scope: string, key: string) => cache.get(`${scope}|${key}`) ?? null,
    save: async (scope: string, key: string, v: unknown) => { cache.set(`${scope}|${key}`, v); },
  };
  const service = new ItemPickupService(prisma as never, { forOrg: async () => pos } as never, items as never, idempotency as never);
  const settle = () => new Promise((r) => setImmediate(r));
  return { service, audits, deleted, pushed, settle };
}

const staff: PickupActor = { type: 'user', id: 'u1' };
const ipad: PickupActor = { type: 'device', id: 'd2' };
const code = (err: unknown) => (err as ConflictException).getResponse() as { code: string; message: string };

describe('a seller picking up an item (Plan 43)', () => {
  it('picks it up, records who and how many, audits it, and takes it out of Square', async () => {
    const row = item();
    const t = harness([row]);
    const result = await t.service.pickUpBySku('org', 'swap', ' 67169 ', staff);
    await t.settle();
    expect(result).toMatchObject({ outcome: 'picked_up', squareChecked: true, item: { id: 'i1', pickedUpBy: 'Pat Lee' } });
    expect(row).toMatchObject({ pickedUpBy: 'u1', pickedUpByName: 'Pat Lee', pickedUpUnits: 1 });
    expect(t.audits[0]).toMatchObject({ action: 'ski_swap.item.picked_up', actorType: 'user', actorId: 'u1' });
    expect(t.deleted).toEqual(['sq-1']);
    // The Square ids stay: past sales still map to the item (D3).
    expect(row.squareVariationId).toBe('sv-1');
  });

  it('refuses an item Square says has sold', async () => {
    const t = harness([item()], { stock: new Map([['sv-1', 0]]) });
    const err = await t.service.pickUp('org', 'swap', 'i1', staff).catch((e) => e);
    expect(code(err).code).toBe('ITEM_SOLD');
    expect(t.audits).toHaveLength(0);
  });

  it('picks up the unsold units of a partly sold item', async () => {
    const row = item({ originalQuantity: 5 });
    const t = harness([row], { stock: new Map([['sv-1', 3]]) });
    await t.service.pickUp('org', 'swap', 'i1', staff);
    expect(row.pickedUpUnits).toBe(3);
  });

  it('picks up anyway when Square can’t be read, and says so', async () => {
    const row = item();
    const t = harness([row], { stock: 'throws' });
    const result = await t.service.pickUp('org', 'swap', 'i1', staff);
    expect(result).toMatchObject({ outcome: 'picked_up', squareChecked: false });
    expect(row.pickedUpUnits).toBe(1);
  });

  it('refuses one never accepted, and one the session isn’t locked to', async () => {
    const t = harness([item({ consignedAt: null }), item({ id: 'i2', sku: '67170' })]);
    expect(code(await t.service.pickUp('org', 'swap', 'i1', staff).catch((e) => e)).code).toBe('NOT_RECEIVED');
    const wrong = code(await t.service.pickUp('org', 'swap', 'i2', staff, { sellerId: 's9' }).catch((e) => e));
    expect(wrong).toEqual({ code: 'WRONG_SELLER', message: 'This is Little Mountain’s item, not Geigers’. Not picked up.', details: { owner: 'Little Mountain' } });
  });

  it('says so for a SKU it doesn’t know', async () => {
    const t = harness([]);
    await expect(t.service.pickUpBySku('org', 'swap', '99999', staff)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('treats a second pickup as already picked up, not an error', async () => {
    const t = harness([item()]);
    await t.service.pickUp('org', 'swap', 'i1', staff);
    const again = await t.service.pickUp('org', 'swap', 'i1', ipad);
    expect(again.outcome).toBe('already_picked_up');
    expect(t.audits).toHaveLength(1);
  });

  it('replays a queued iPad pickup from its key', async () => {
    const t = harness([item()]);
    const first = await t.service.pickUp('org', 'swap', 'i1', ipad, {}, 'i1-pickup-1');
    const replay = await t.service.pickUp('org', 'swap', 'i1', ipad, {}, 'i1-pickup-1');
    expect(replay).toEqual(first);
    expect(replay.outcome).toBe('picked_up');
  });

  it('keeps an offline scan’s time when it’s plausible, and uses its own otherwise', async () => {
    const early = item();
    const t = harness([early, item({ id: 'i2' }), item({ id: 'i3' })]);
    await t.service.pickUp('org', 'swap', 'i1', ipad, { pickedUpAt: '2026-10-05T18:00:00.000Z' });
    expect(early.pickedUpAt?.toISOString()).toBe('2026-10-05T18:00:00.000Z');
    const before = Date.now();
    await t.service.pickUp('org', 'swap', 'i2', ipad, { pickedUpAt: '2026-01-01T00:00:00.000Z' });
    await t.service.pickUp('org', 'swap', 'i3', ipad, { pickedUpAt: '2999-01-01T00:00:00.000Z' });
    for (const id of ['i2', 'i3']) {
      const at = (await t.service.pickUp('org', 'swap', id, ipad)).item as unknown as { pickedUpAt: string };
      expect(new Date(at.pickedUpAt).getTime()).toBeGreaterThanOrEqual(before);
    }
  });

  it('keeps the pickup when Square refuses the delete', async () => {
    const row = item();
    const t = harness([row], { deleteFails: true });
    const result = await t.service.pickUp('org', 'swap', 'i1', staff);
    await t.settle();
    expect(result.outcome).toBe('picked_up');
    expect(row.pickedUpAt).not.toBeNull();
  });

  it('records an iPad as the device that picked it up', async () => {
    const row = item();
    const t = harness([row]);
    await t.service.pickUp('org', 'swap', 'i1', ipad);
    expect(row).toMatchObject({ pickedUpBy: 'd2', pickedUpByName: 'iPad 2' });
    expect(t.audits[0]).toMatchObject({ actorType: 'device', actorId: 'd2' });
  });
});

describe('undoing a pickup (Plan 43 D4)', () => {
  it('puts it back on sale as a new Square item, and audits it', async () => {
    const row = item({ pickedUpAt: new Date(), pickedUpBy: 'u1', pickedUpByName: 'Pat Lee', pickedUpUnits: 1 });
    const t = harness([row]);
    await t.service.undo('org', 'swap', 'i1', staff);
    expect(row).toMatchObject({ pickedUpAt: null, pickedUpUnits: null, squareItemId: null, squareVariationId: null });
    expect(t.pushed).toEqual(['i1']);
    expect(t.audits[0].action).toBe('ski_swap.item.pickup_undone');
  });

  it('refuses an item with any units sold, and one not picked up', async () => {
    const t = harness([item({ originalQuantity: 5, pickedUpAt: new Date(), pickedUpUnits: 3 }), item({ id: 'i2' })]);
    expect(code(await t.service.undo('org', 'swap', 'i1', staff).catch((e) => e)).code).toBe('PARTLY_SOLD');
    expect(code(await t.service.undo('org', 'swap', 'i2', staff).catch((e) => e)).code).toBe('NOT_PICKED_UP');
    expect(t.pushed).toEqual([]);
  });
});

describe('a locked session’s list (Plan 43 D5)', () => {
  it('lists the seller’s items with units still in Square', async () => {
    const t = harness([item(), item({ id: 'i2', sku: '67170', squareVariationId: 'sv-2' }), item({ id: 'i3', sku: '67171', squareVariationId: 'sv-3' })],
      { stock: new Map([['sv-1', 1], ['sv-2', 0]]) });
    const { items, squareChecked } = await t.service.awaitingPickup('org', 'swap', 's1');
    expect(squareChecked).toBe(true);
    // 67170 sold; 67171 Square couldn't count, so it's still listed.
    expect(items.map((i) => i.sku)).toEqual(['67169', '67171']);
  });

  it('reads Square for the check-in iPad too, and the device interceptor keeps units (iOS Plan 37)', async () => {
    const t = harness([item(), item({ id: 'i2', sku: '67170', squareVariationId: 'sv-2' })], { stock: new Map([['sv-1', 1], ['sv-2', 0]]) });
    const answer = await deviceRequest.run(true, () => t.service.awaitingPickup('org', 'swap', 's1'));
    expect(answer.squareChecked).toBe(true);
    expect(answer.items.map((i) => i.sku)).toEqual(['67169']);
    const interceptor = new DeviceStockInterceptor();
    const ctx = { switchToHttp: () => ({ getRequest: () => ({ device: { deviceId: 'ipad' } }) }) } as never;
    const sent = await lastValueFrom(interceptor.intercept(ctx, { handle: () => of(answer) }));
    // Unchanged: no stock fields to strip, and `units` (Square's count, read on the server) kept.
    expect(sent).toEqual(answer);
    expect((sent as typeof answer).items[0].units).toBe(1);
  });
});

describe('the awaiting-pickup route (iOS Plan 37)', () => {
  it('lets a staff check-in iPad in, as the pickup route does', () => {
    const reflector = new Reflector();
    expect(reflector.getAllAndOverride(DEVICE_ROLES_KEY, [ItemController.prototype.awaitingPickup, ItemController])).toEqual(['ski_swap.staff_check_in']);
    expect(reflector.getAllAndOverride(DEVICE_ROLES_KEY, [ItemController.prototype.pickUp, ItemController])).toEqual(['ski_swap.staff_check_in']);
  });
});
