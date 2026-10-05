import { ConflictException } from '@nestjs/common';
import { SellerSelfService } from './seller-self.service';
import { ItemService } from './item.service';

/**
 * A shop filling in its issued tickets (Plan 38 D6, D7): once, while nobody
 * has described or priced it and it hasn't sold. After that it's staff's.
 */

const issued = (over: Record<string, unknown> = {}) => ({
  id: 't67169', orgId: 'org-1', swapId: 'swap-1', sellerId: 'seller-1', sku: '67169', name: 'Item #67169',
  priceCents: null, categoryId: null, description: null, consignedAt: new Date(), deletedAt: null, ...over,
});

function shop(item: Record<string, unknown>, opts: { sold?: boolean } = {}) {
  const patched: Record<string, unknown>[] = [];
  const photos: string[] = [];
  const prisma = {
    sellerProfile: { findFirst: async () => ({ id: 'seller-1', businessName: 'Stowe Sports' }) },
    swapItem: { findFirst: async () => item, findFirstOrThrow: async () => item },
  };
  const items = {
    patch: async (_o: string, _s: string, _id: string, data: Record<string, unknown>) => { patched.push(data); return data; },
    soldAmong: async (_o: string, _s: string, ids: string[]) => new Set(opts.sold ? ids : []),
    uploadPhoto: async () => { photos.push('up'); return {}; },
  };
  const svc = new SellerSelfService(prisma as never, items as never, {} as never, {} as never, {} as never, {} as never);
  return { svc, patched, photos };
}

const photo = { buffer: Buffer.from(''), mimetype: 'image/jpeg', originalname: 'a.jpg' };

describe('a shop editing its issued ticket', () => {
  it('may fill it in while nobody has', async () => {
    const { svc, patched } = shop(issued());
    await svc.updateItem('org-1', 'user-1', 't67169', { priceCents: 4500 });
    expect(patched[0]).toMatchObject({ priceCents: 4500 });
  });

  it('is refused once it’s described, and told to ask staff', async () => {
    const { svc, patched } = shop(issued({ priceCents: 4500 }));
    const err = await svc.updateItem('org-1', 'user-1', 't67169', { priceCents: 5000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({ code: 'TICKET_DESCRIBED', message: '67169 is already described. Ask the swap’s staff to change it.' });
    expect(patched).toHaveLength(0);
  });

  it('is refused once it has sold', async () => {
    const { svc } = shop(issued(), { sold: true });
    const err = await svc.updateItem('org-1', 'user-1', 't67169', { priceCents: 4500 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'TICKET_SOLD' });
  });

  it('may add photos until it sells, described or not', async () => {
    const described = shop(issued({ priceCents: 4500 }));
    await described.svc.uploadPhoto('org-1', 'user-1', 't67169', photo);
    expect(described.photos).toHaveLength(1);
    const sold = shop(issued(), { sold: true });
    await expect(sold.svc.uploadPhoto('org-1', 'user-1', 't67169', photo)).rejects.toThrow(/has sold/);
  });

  it('leaves an accepted item that isn’t a ticket as it was: staff only', async () => {
    const { svc } = shop(issued({ sku: 'SS26-A-0001', name: 'Skis' }));
    const err = await svc.updateItem('org-1', 'user-1', 't67169', { priceCents: 4500 }).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: 'ITEM_ACCEPTED' });
  });
});

// ─── Files filling in tickets ────────────────────────────────────────────────

function importer(checked: Record<string, unknown>[], opts: { sold?: string[] } = {}) {
  const patched: { id: string; data: Record<string, unknown> }[] = [];
  const service = new ItemService(
    { skiSwap: { findFirst: async () => ({ id: 'swap-1', allowPrintWeb: true, allowLegacyWeb: true, locationId: '' }) } } as never,
    { forOrg: async () => null } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { checkImportRows: async () => checked } as never,
    {} as never,
  );
  const stub = service as unknown as Record<string, unknown>;
  stub.patch = async (_o: string, _s: string, id: string, data: Record<string, unknown>) => { patched.push({ id, data }); return {}; };
  stub.soldAmong = async () => new Set(opts.sold ?? []);
  return { service, patched };
}

describe('a file of ticket rows', () => {
  const rows = [{ sku: '67169', name: 'Salomon boots', description: '27.5', priceCents: 18000 }, { sku: '67170', priceCents: null }];
  const checked = [
    { line: 2, sku: '67169', outcome: 'ok', itemId: 't67169' },
    { line: 3, sku: '67170', outcome: 'ok', itemId: 't67170' },
  ];

  it('fills in the issued tickets it names, rather than creating any', async () => {
    const { service, patched } = importer(checked);
    const results = await service.importItems('org-1', 'swap-1', 'seller-1', rows, { selfService: false });
    expect(results.map((r) => r.outcome)).toEqual(['updated', 'updated']);
    // The second row only names its ticket: nothing to write.
    expect(patched).toEqual([
      { id: 't67169', data: { name: 'Salomon boots', description: '27.5', priceCents: 18000 } },
    ]);
  });

  it('from a shop, writes nothing if any of its tickets has sold', async () => {
    const { service, patched } = importer(checked, { sold: ['t67170'] });
    const results = await service.importItems('org-1', 'swap-1', 'seller-1', rows, { selfService: true });
    expect(results[1]).toMatchObject({ outcome: 'error', error: '67170 has sold. Ask the swap’s staff to change it.' });
    expect(patched).toHaveLength(0);
  });
});
