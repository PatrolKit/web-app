import { SellerService } from './seller.service';
import { PAYOUT_CHANGED, payoutChange, type PayoutFields } from './payout-history';

/**
 * A seller's payout history: a row each time how they're paid, or where the
 * money goes, changes — and never for an edit that leaves it where it was.
 */

const dana: PayoutFields = {
  payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL', payoutHandle: null,
  email: 'dana@example.com', phone: '+18025551212',
  street: '12 Main St', city: 'Stowe', state: 'VT', zip: '05672',
};

describe('what counts as a payout change', () => {
  it('a new method is one, from where the money went to where it goes', () => {
    expect(payoutChange(dana, { ...dana, payoutMethod: 'CHECK', payoutTarget: null })).toEqual({
      from: { method: 'PAYPAL', destination: 'dana@example.com' },
      to: { method: 'CHECK', destination: '12 Main St, Stowe, VT 05672' },
    });
  });

  it('a new email moves a PayPal payout, so it is one', () => {
    expect(payoutChange(dana, { ...dana, email: 'dana.r@example.com' })?.to).toEqual({ method: 'PAYPAL', destination: 'dana.r@example.com' });
  });

  it('a new address moves a check', () => {
    const check = { ...dana, payoutMethod: 'CHECK', payoutTarget: null };
    expect(payoutChange(check, { ...check, street: '9 Elm St' })?.to.destination).toBe('9 Elm St, Stowe, VT 05672');
  });

  it('an edit that leaves the money where it was is not', () => {
    expect(payoutChange(dana, { ...dana, street: '9 Elm St', phone: null })).toBeNull();
    expect(payoutChange(dana, { ...dana })).toBeNull();
  });

  it('a first choice comes from nothing; no choice at all is no change', () => {
    const none = { ...dana, payoutMethod: null, payoutTarget: null };
    expect(payoutChange(none, dana)).toEqual({ from: null, to: { method: 'PAYPAL', destination: 'dana@example.com' } });
    expect(payoutChange(none, { ...none, city: 'Stowe' })).toBeNull();
  });
});

describe('a seller write keeps the history', () => {
  function build(user: Record<string, unknown>) {
    const audits: Record<string, unknown>[] = [];
    const prisma = {
      user: { findUniqueOrThrow: async () => user, update: async () => ({}) },
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return {}; } },
    };
    const svc = new SellerService(prisma as never, {} as never, {} as never, { touchAllForUser: async () => undefined } as never, {} as never);
    const inner = svc as unknown as {
      writeUserFields: (id: string, d: object, o: object) => Promise<ReturnType<typeof payoutChange>>;
      recordPayoutChange: (orgId: string, sellerId: string, c: ReturnType<typeof payoutChange>, a?: object) => Promise<void>;
    };
    const write = async (data: object, actor?: object) =>
      inner.recordPayoutChange('org-1', 'seller-1', await inner.writeUserFields('user-1', data, { overwrite: true }), actor);
    return { write, audits };
  }
  const user = { ...dana, firstName: 'Dana', lastName: 'Reyes', emailVerifiedAt: new Date(), phoneVerifiedAt: null, payoutHandleScannedAt: null };
  const staff = { via: 'staff', actorType: 'user', actorId: 'staff-1' };

  it('records who switched them to checks, and from what', async () => {
    const { write, audits } = build(user);
    await write({ payoutMethod: 'CHECK', payoutTarget: null }, staff);
    expect(audits).toEqual([expect.objectContaining({
      actorType: 'user', actorId: 'staff-1', orgId: 'org-1', action: PAYOUT_CHANGED, targetType: 'seller', targetId: 'seller-1',
      metadata: { via: 'staff', from: { method: 'PAYPAL', destination: 'dana@example.com' }, to: { method: 'CHECK', destination: '12 Main St, Stowe, VT 05672' } },
    })]);
  });

  it('records nothing for an edit that doesn’t move the money', async () => {
    const { write, audits } = build(user);
    await write({ city: 'Stowe' }, staff);
    await write({ payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL' }, staff);
    expect(audits).toEqual([]);
  });
});

describe('reading the history', () => {
  it('names who made each change, newest first as stored', async () => {
    const rows = [
      { createdAt: new Date('2026-11-13T15:00:00Z'), actorType: 'device', actorId: 'ipad-1', metadata: { via: 'tablet', from: null, to: { method: 'CHECK', destination: 'x' } } },
      { createdAt: new Date('2026-11-12T15:00:00Z'), actorType: 'user', actorId: 'gone', metadata: { via: 'staff', from: null, to: { method: 'PAYPAL', destination: 'y' } } },
    ];
    let where: unknown;
    const prisma = {
      sellerProfile: { findFirst: async () => ({ id: 'seller-1' }) },
      auditLog: { findMany: async (q: { where: unknown }) => { where = q.where; return rows; } },
      user: { findMany: async () => [] },
      device: { findMany: async () => [{ id: 'ipad-1', name: 'Counter iPad 3' }] },
    };
    const svc = new SellerService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    (svc as unknown as { findOrThrow: () => Promise<object> }).findOrThrow = async () => ({});
    const history = await svc.payoutHistory('org-1', 'seller-1');
    expect(where).toEqual({ orgId: 'org-1', action: PAYOUT_CHANGED, targetType: 'seller', targetId: 'seller-1' });
    expect(history).toEqual([
      { at: '2026-11-13T15:00:00.000Z', via: 'tablet', by: 'Counter iPad 3', from: null, to: { method: 'CHECK', destination: 'x' } },
      { at: '2026-11-12T15:00:00.000Z', via: 'staff', by: null, from: null, to: { method: 'PAYPAL', destination: 'y' } },
    ]);
  });
});
