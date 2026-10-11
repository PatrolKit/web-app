import { ForbiddenException, NotFoundException, RequestMethod } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { DEVICE_ROLES_KEY } from '../common/decorators/require-device-role.decorator';
import { PublicStatusService } from './public-status.service';
import { ItemController } from './item.controller';

/** The iPad's Item Status Kiosk: one tag's verdict, for the patrol's devices only. */

const item = (sku: string, over: Record<string, unknown> = {}) => ({
  sku, name: `Item ${sku}`, consignedAt: new Date(), squareVariationId: `v-${sku}`, originalQuantity: 1, pickedUpAt: null, ...over,
});

function harness(stock: Record<string, number> | null) {
  const items = [item('75040'), item('75041'), item('75042', { pickedUpAt: new Date() }), item('75043', { consignedAt: null })];
  const prisma = {
    // The SKU Lookup switch is off: the kiosk doesn't need it on.
    skiSwap: { findFirst: async ({ where }: { where: { id: string; orgId: string } }) => (where.id === 'swap' && where.orgId === 'org' ? { id: 'swap', locationId: 'loc', skuLookupEnabled: false } : null) },
    swapItem: { findFirst: async ({ where }: { where: { sku: string } }) => items.find((i) => i.sku === where.sku) ?? null },
  };
  const pos = {
    getInventoryCounts: async (ids: string[]) => {
      if (stock === null) throw new Error('Square is down');
      return new Map(ids.map((id) => [id, stock[id] ?? 0]));
    },
  };
  return new PublicStatusService(prisma as never, { forOrg: async () => pos } as never);
}

describe('the kiosk’s item status', () => {
  it('answers the verdict and the tag only, read live from Square', async () => {
    const svc = harness({ 'v-75040': 0, 'v-75041': 1 });
    expect(await svc.deviceSku('org', 'swap', ' 75040 ')).toEqual({ sku: '75040', status: 'sold' });
    expect(await svc.deviceSku('org', 'swap', '75041')).toEqual({ sku: '75041', status: 'for_sale' });
    expect(await svc.deviceSku('org', 'swap', '75042')).toEqual({ sku: '75042', status: 'picked_up' });
    expect(await svc.deviceSku('org', 'swap', '75043')).toEqual({ sku: '75043', status: 'not_received' });
  });

  it('says unknown, never a guess, when Square can’t be read', async () => {
    expect(await harness(null).deviceSku('org', 'swap', '75040')).toEqual({ sku: '75040', status: 'unknown' });
  });

  it('is a 404 with ITEM_NOT_FOUND for a tag no item has', async () => {
    const err = await harness({}).deviceSku('org', 'swap', '99999').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toMatchObject({ code: 'ITEM_NOT_FOUND', message: 'No item with that SKU in this swap.' });
  });

  it('is a plain 404 for another org’s swap', async () => {
    await expect(harness({}).deviceSku('other', 'swap', '75040')).rejects.toThrow('Swap not found');
  });
});

describe('the sku-status route', () => {
  const reflector = new Reflector();

  it('is a GET open to staff check-in iPads, and refuses a person’s token', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, ItemController.prototype.skuStatus)).toBe(RequestMethod.GET);
    expect(reflector.getAllAndOverride(DEVICE_ROLES_KEY, [ItemController.prototype.skuStatus, ItemController])).toEqual(['ski_swap.staff_check_in']);
    const controller = new ItemController({} as never, {} as never, {} as never, {} as never, {} as never, {} as never, harness({}) as never);
    expect(() => controller.skuStatus('org', 'swap', { user: { userId: 'u' } } as never, '75040')).toThrow(ForbiddenException);
  });

  it('comes before the item-id route, so "sku-status" isn’t read as an id', () => {
    const names = Object.getOwnPropertyNames(ItemController.prototype);
    expect(names.indexOf('skuStatus')).toBeLessThan(names.indexOf('get'));
  });
});
