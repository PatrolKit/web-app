import { ConflictException } from '@nestjs/common';
import { SellerSelfService } from './seller-self.service';

/**
 * Once staff accept an item for sale, its seller can't change it: not its
 * price, quantity, details, donation, notes or photos. Changes to an item
 * that is live at the register are made at the counter. Until then, anything.
 */

function build(consigned: boolean) {
  const item = { id: 'item-1', name: 'Volkl Kendo 88', swapId: 'swap-1', sellerId: 'seller-1', consignedAt: consigned ? new Date() : null };
  const calls: string[] = [];
  const prisma = {
    sellerProfile: { findFirst: async () => ({ id: 'seller-1', businessName: null }) },
    swapItem: { findFirst: async () => item, findFirstOrThrow: async () => item },
  };
  const items = {
    patch: async (_o: string, _s: string, _i: string, data: object) => { calls.push(`patch ${Object.keys(data).join(',')}`); return item; },
    remove: async () => { calls.push('remove'); },
    uploadPhoto: async () => { calls.push('upload'); },
    deletePhoto: async () => { calls.push('deletePhoto'); },
  };
  const unused = {} as never;
  const svc = new SellerSelfService(prisma as never, items as never, unused, unused, unused, unused);
  return { svc, calls };
}

const photo = { buffer: Buffer.from(''), mimetype: 'image/jpeg', originalname: 'a.jpg' };

describe('a seller and their accepted item', () => {
  it.each([
    ['price', { priceCents: 9900 }],
    ['quantity', { quantity: 1 }],
    ['details', { categoryId: 'cat-1', attributes: [] }],
    ['donation', { donateProceeds: true }],
    ['notes', { description: 'Freshly waxed' }],
  ])('cannot change its %s', async (_what, data) => {
    const { svc, calls } = build(true);
    const err = await svc.updateItem('org-1', 'user-1', 'item-1', data).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: 'ITEM_ACCEPTED' });
    expect(calls).toEqual([]);
  });

  it('cannot add or remove its photos', async () => {
    const { svc, calls } = build(true);
    await expect(svc.uploadPhoto('org-1', 'user-1', 'item-1', photo)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.deletePhoto('org-1', 'user-1', 'item-1', 'photo-1')).rejects.toBeInstanceOf(ConflictException);
    expect(calls).toEqual([]);
  });

  it('can still record that a tag was printed for it', async () => {
    const { svc, calls } = build(true);
    await svc.updateItem('org-1', 'user-1', 'item-1', { hasPrintedTag: true });
    expect(calls).toEqual(['patch hasPrintedTag']);
  });
});

describe('a seller and an item not yet accepted', () => {
  it('can change anything about it', async () => {
    const { svc, calls } = build(false);
    await svc.updateItem('org-1', 'user-1', 'item-1', { priceCents: 9900, quantity: 2, description: 'x', donateProceeds: true });
    await svc.uploadPhoto('org-1', 'user-1', 'item-1', photo);
    await svc.deletePhoto('org-1', 'user-1', 'item-1', 'photo-1');
    expect(calls).toEqual(['patch priceCents,quantity,description,donateProceeds', 'upload', 'deletePhoto']);
  });
});
