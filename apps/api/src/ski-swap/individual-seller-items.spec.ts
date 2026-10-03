import { ForbiddenException } from '@nestjs/common';
import { SellerSelfService } from './seller-self.service';
import { MembersService } from '../members/members.service';

/**
 * An individual seller adds items only while checking in, at a station, from
 * its QR code, and can't change them afterwards from My Items. A shop manages
 * its own from its desk, as before.
 */

function build(businessName: string | null) {
  const calls: string[] = [];
  const item = { id: 'item-1', name: 'Skis', swapId: 'swap-1', sellerId: 'seller-1', consignedAt: null };
  const prisma = {
    sellerProfile: { findFirst: async () => ({ id: 'seller-1', businessName }) },
    checkinStation: { findFirst: async ({ where }: { where: { id: string } }) => (where.id === 'station-1' ? { id: 'station-1' } : null) },
    skiSwap: { findFirst: async () => ({ id: 'swap-1', webLegacyTicketsOnly: false }) },
    swapItem: { findFirst: async () => item, findFirstOrThrow: async () => item },
  };
  const tickets = { isLegacySeller: async () => false };
  const items = {
    createAtStation: async () => { calls.push('create'); return {}; },
    patch: async () => { calls.push('patch'); return item; },
    remove: async () => { calls.push('remove'); },
    uploadPhoto: async () => { calls.push('upload'); },
    deletePhoto: async () => { calls.push('deletePhoto'); },
    importItems: async () => { calls.push('import'); return []; },
  };
  const printQueue = { reprintItem: async () => { calls.push('reprint'); } };
  const unused = {} as never;
  return { svc: new SellerSelfService(prisma as never, items as never, unused, printQueue as never, unused, tickets as never), calls };
}

const ITEM = { swapId: 'swap-1', categoryId: 'cat-skis', priceCents: 2500, quantity: 1 };
const photo = { buffer: Buffer.from(''), mimetype: 'image/jpeg', originalname: 'a.jpg' };

describe('an individual seller', () => {
  it('adds an item at a station, while checking in', async () => {
    const { svc, calls } = build(null);
    await svc.createItem('org-1', 'user-1', { ...ITEM, stationId: 'station-1' });
    expect(calls).toEqual(['create']);
  });

  it('can’t add one from My Items, away from a station', async () => {
    const { svc, calls } = build(null);
    await expect(svc.createItem('org-1', 'user-1', ITEM)).rejects.toThrow(/check-in QR code/);
    expect(calls).toEqual([]);
  });

  it('can’t change, remove, or photograph items afterwards, or upload a file', async () => {
    const { svc, calls } = build(null);
    for (const attempt of [
      svc.updateItem('org-1', 'user-1', 'item-1', { priceCents: 100 }),
      svc.deleteItem('org-1', 'user-1', 'item-1'),
      svc.uploadPhoto('org-1', 'user-1', 'item-1', photo),
      svc.deletePhoto('org-1', 'user-1', 'item-1', 'photo-1'),
      svc.importItems('org-1', 'user-1', 'swap-1', []),
    ]) {
      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(calls).toEqual([]);
  });

  it('can still photograph an item and reprint its tag at the station while checking in', async () => {
    const { svc, calls } = build(null);
    await svc.uploadPhoto('org-1', 'user-1', 'item-1', photo, 'station-1');
    await svc.reprintItem('org-1', 'user-1', 'item-1', 'station-1');
    expect(calls).toEqual(['upload', 'reprint']);
    await expect(svc.uploadPhoto('org-1', 'user-1', 'item-1', photo, 'nowhere')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('a shop', () => {
  it('still adds, changes and uploads from its desk', async () => {
    const { svc, calls } = build('Alpine Sports');
    await svc.createItem('org-1', 'user-1', ITEM);
    await svc.updateItem('org-1', 'user-1', 'item-1', { priceCents: 100 });
    await svc.importItems('org-1', 'user-1', 'swap-1', []);
    expect(calls).toEqual(['create', 'patch', 'import']);
  });
});

describe('a member invite', () => {
  function members(user: { email: string | null; verifiedEmail: string | null }) {
    const sent: { to: string; org: string }[] = [];
    const prisma = {
      membership: { findUnique: async () => ({ deletedAt: null, user, org: { name: 'BMBWAV Ski Patrol' } }) },
    };
    const mail = { sendMemberInvite: async (to: string, org: string) => { sent.push({ to, org }); return { status: 'sent' }; } };
    const unused = {} as never;
    return { svc: new MembersService(prisma as never, unused, unused, unused, unused, mail as never), sent };
  }

  it('is emailed to the member’s address, naming the org', async () => {
    const { svc, sent } = members({ email: 'dana@example.com', verifiedEmail: null });
    await expect(svc.sendInvite('org-1', 'user-1')).resolves.toEqual({ sentTo: 'dana@example.com', status: 'sent' });
    expect(sent).toEqual([{ to: 'dana@example.com', org: 'BMBWAV Ski Patrol' }]);
  });

  it('is refused for a member with no email', async () => {
    const { svc, sent } = members({ email: null, verifiedEmail: null });
    await expect(svc.sendInvite('org-1', 'user-1')).rejects.toThrow(/no email address/);
    expect(sent).toEqual([]);
  });
});
