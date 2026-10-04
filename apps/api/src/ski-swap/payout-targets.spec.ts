import { BadRequestException } from '@nestjs/common';
import { SellerService, payoutHandleScannedAt } from './seller.service';
import { assertScanFromDevice } from './seller.controller';

/**
 * No unverified electronic payment target (Plan 35). PayPal pays a verified
 * email only; Venmo pays only an account scanned from the seller's code at the
 * counter, on the staff iPad.
 */

describe('what a payout write may set', () => {
  const none = { handle: null, scannedAt: null };

  it('refuses PayPal to anything but the email', () => {
    expect(() => payoutHandleScannedAt({ method: 'PAYPAL', target: 'PAYPAL_ID', handle: 'ABC' }, none, undefined))
      .toThrow(/verified email only/);
    expect(() => payoutHandleScannedAt({ method: 'PAYPAL', target: 'PHONE', handle: null }, none, undefined))
      .toThrow(/verified email only/);
    expect(payoutHandleScannedAt({ method: 'PAYPAL', target: 'EMAIL', handle: null }, none, undefined)).toBeNull();
  });

  it('refuses a typed Venmo handle', () => {
    const err = (() => {
      try { payoutHandleScannedAt({ method: 'VENMO', target: 'VENMO_ID', handle: 'dana-r' }, none, undefined); }
      catch (e) { return e as BadRequestException; }
    })();
    expect(err?.getResponse()).toMatchObject({ code: 'VENMO_NOT_SCANNED' });
  });

  it('records when a Venmo handle was scanned', () => {
    const at = payoutHandleScannedAt({ method: 'VENMO', target: 'VENMO_ID', handle: 'dana-r' }, none, 'SCAN');
    expect(at).toBeInstanceOf(Date);
  });

  it('keeps a scanned handle saved again unchanged, and refuses a changed one', () => {
    const scannedAt = new Date('2026-10-01T12:00:00Z');
    expect(payoutHandleScannedAt({ method: 'VENMO', target: 'VENMO_ID', handle: 'dana-r' }, { handle: 'dana-r', scannedAt }, undefined))
      .toBe(scannedAt);
    expect(() => payoutHandleScannedAt({ method: 'VENMO', target: 'VENMO_ID', handle: 'someone-else' }, { handle: 'dana-r', scannedAt }, undefined))
      .toThrow(/scanning the seller’s Venmo code/);
  });

  it('forgets the scan once there’s no Venmo handle', () => {
    const scannedAt = new Date();
    expect(payoutHandleScannedAt({ method: 'CHECK', target: null, handle: null }, { handle: 'dana-r', scannedAt }, undefined)).toBeNull();
  });
});

describe('a scan claimed by something other than the iPad', () => {
  it('is refused', () => {
    expect(() => assertScanFromDevice({ payoutHandleSource: 'SCAN' }, undefined)).toThrow(/Only the staff iPad/);
  });

  it('is accepted from the iPad, and nothing is asked of a write without one', () => {
    expect(() => assertScanFromDevice({ payoutHandleSource: 'SCAN' }, { deviceId: 'd', orgId: 'o', clientId: 'c', role: 'ski_swap.staff_check_in' })).not.toThrow();
    expect(() => assertScanFromDevice({}, undefined)).not.toThrow();
  });
});

describe('a seller’s payout written through the seller API', () => {
  function build(user: Record<string, unknown>) {
    const writes: Record<string, unknown>[] = [];
    const prisma = {
      user: {
        findUniqueOrThrow: async () => user,
        update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return {}; },
      },
    };
    const svc = new SellerService(prisma as never, {} as never, {} as never, { touchAllForUser: async () => undefined } as never, {} as never);
    const write = (data: Record<string, unknown>) =>
      (svc as unknown as { writeUserFields: (id: string, d: object, o: object) => Promise<void> })
        .writeUserFields('user-1', data, { overwrite: true });
    return { write, writes };
  }
  const dana = {
    firstName: 'Dana', lastName: 'Reyes', street: null, city: null, state: null, zip: null,
    email: 'dana@example.com', emailVerifiedAt: new Date(), verifiedEmail: 'dana@example.com',
    phone: null, phoneVerifiedAt: null, verifiedPhone: null,
    payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID', payoutHandle: 'dana-r', payoutHandleScannedAt: null,
  };

  it('stores a scanned Venmo account with when it was scanned', async () => {
    const { write, writes } = build({ ...dana, payoutMethod: 'CHECK', payoutTarget: null, payoutHandle: null });
    await write({ payoutMethod: 'VENMO', payoutTarget: 'VENMO_ID', payoutHandle: 'dana-r', payoutHandleSource: 'SCAN' });
    expect(writes[0]).toMatchObject({ payoutHandle: 'dana-r', payoutHandleScannedAt: expect.any(Date) });
  });

  it('lets an unrelated edit through for a seller whose Venmo was never scanned', async () => {
    const { write, writes } = build(dana);
    await write({ city: 'Stowe' });
    expect(writes[0]).toEqual({ city: 'Stowe' });
  });

  it('clears the scan when the seller moves to a check', async () => {
    const { write, writes } = build({ ...dana, payoutHandleScannedAt: new Date() });
    await write({ payoutMethod: 'CHECK', payoutTarget: null, payoutHandle: null });
    expect(writes[0]).toMatchObject({ payoutMethod: 'CHECK', payoutHandleScannedAt: null });
  });
});
