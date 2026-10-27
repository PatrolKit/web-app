import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SellerController } from './seller.controller';
import { lineEffect, payoutChoice } from './seller-merge.service';

/** Plan 57: what a merge does to each payout line, which payouts can move, and who may merge. */

describe('a payout line in a merge (D4)', () => {
  const at = new Date();
  it('of the other seller, in an open run and unpaid, is taken out of the run', () => {
    expect(lineEffect({ status: 'PENDING', frozenAt: null }, false, true)).toBe('removed');
    expect(lineEffect({ status: 'APPROVED', frozenAt: null }, false, true)).toBe('removed');
  });

  it('of the other seller, once money has moved, refuses the merge', () => {
    for (const status of ['SENDING', 'SENT', 'UNCLAIMED', 'ONHOLD', 'EXPORTED']) {
      expect(lineEffect({ status, frozenAt: at }, false, true)).toBe('blocks');
    }
  });

  it('of the other seller, that paid nothing, stays as history', () => {
    for (const status of ['FAILED', 'RETURNED', 'CANCELLED']) {
      expect(lineEffect({ status, frozenAt: at }, false, false)).toBe('history');
    }
  });

  it('of the kept seller, approved in an open run, goes back to review; otherwise stays', () => {
    expect(lineEffect({ status: 'APPROVED', frozenAt: null }, true, true)).toBe('unapproved');
    expect(lineEffect({ status: 'PENDING', frozenAt: null }, true, true)).toBe('stays');
    expect(lineEffect({ status: 'SENT', frozenAt: at }, true, false)).toBe('stays');
  });
});

describe('a payout taken from the other seller (D3)', () => {
  const user = (over: Record<string, unknown>) => ({
    payoutMethod: null, payoutTarget: null, payoutHandle: null, payoutHandleScannedAt: null, verifiedEmail: null, ...over,
  }) as never;

  it('moves a check, a donation, or a scanned Venmo handle', () => {
    expect(payoutChoice(user({}), user({ payoutMethod: 'CHECK' })).offered).toBe(true);
    expect(payoutChoice(user({}), user({ payoutMethod: 'DONATE' })).offered).toBe(true);
    expect(payoutChoice(user({}), user({ payoutMethod: 'VENMO', payoutHandle: 'x', payoutHandleScannedAt: new Date() })).offered).toBe(true);
  });

  it('never moves an unproven Venmo handle or a PayPal email, and says why', () => {
    const venmo = payoutChoice(user({}), user({ payoutMethod: 'VENMO', payoutHandle: 'x' }));
    const paypal = payoutChoice(user({}), user({ payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL', verifiedEmail: 'a@b.c' }));
    expect([venmo.offered, paypal.offered]).toEqual([false, false]);
    expect(venmo.why).toMatch(/scanned/);
    expect(paypal.why).toMatch(/verified email/);
  });
});

describe('who may merge', () => {
  function guardFor(method: string, principal: { device?: { role: string }; user?: { userId: string } }, granted: string[] = []) {
    const guard = new PermissionsGuard(new Reflector(), { getPermissions: async () => granted } as never);
    const controller = SellerController.prototype as unknown as Record<string, unknown>;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ ...principal, params: { orgId: 'org-1' } }) }),
      getHandler: () => controller[method],
      getClass: () => SellerController,
    };
    return () => guard.canActivate(ctx as never);
  }

  it('is a Ski Swap admin, not someone who only manages sellers', async () => {
    for (const method of ['mergePreview', 'merge']) {
      await expect(guardFor(method, { user: { userId: 'u' } }, ['ski_swap:manage'])()).rejects.toBeInstanceOf(ForbiddenException);
      await expect(guardFor(method, { user: { userId: 'u' } }, ['ski_swap:admin'])()).resolves.toBe(true);
    }
  });

  it('is never a tablet, though the rest of the controller lets one in', async () => {
    await expect(guardFor('merge', { device: { role: 'org.tablet' } })()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guardFor('get', { device: { role: 'org.tablet' } }, [])()).resolves.toBe(true);
  });
});
