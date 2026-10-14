import { ForbiddenException } from '@nestjs/common';
import { HttpPayPalClient, PayPalError, payoutsUnlocked } from './paypal.client';
import { PayoutRunService } from './payout-run.service';
import { PayoutNudgeService } from './payout-nudge.service';

/**
 * The server's lock on paying out (fail closed): nothing reaches PayPal's
 * payouts endpoints unless the environment says exactly
 * PAYPAL_PAYOUTS_ENABLED=on. A run can be built, reviewed and approved with
 * the money held.
 */

const saved = process.env.PAYPAL_PAYOUTS_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.PAYPAL_PAYOUTS_ENABLED;
  else process.env.PAYPAL_PAYOUTS_ENABLED = saved;
});

function client() {
  const calls: string[] = [];
  global.fetch = jest.fn(async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }), text: async () => '{}' };
  }) as unknown as typeof fetch;
  const prisma = { payPalConfig: { findUnique: async () => ({ clientId: 'id', clientSecretEnc: 'enc', environment: 'live' }) } };
  return { paypal: new HttpPayPalClient(prisma as never, { decrypt: () => 'secret' } as never), calls };
}

describe('the lock', () => {
  it('is on unless the environment says exactly "on"', () => {
    for (const v of [undefined, '', 'true', '1', 'ON', 'yes', ' on']) {
      if (v === undefined) delete process.env.PAYPAL_PAYOUTS_ENABLED;
      else process.env.PAYPAL_PAYOUTS_ENABLED = v;
      expect(payoutsUnlocked()).toBe(false);
    }
    process.env.PAYPAL_PAYOUTS_ENABLED = 'on';
    expect(payoutsUnlocked()).toBe(true);
  });

  it('stops the real client sending or cancelling, before any call to PayPal', async () => {
    delete process.env.PAYPAL_PAYOUTS_ENABLED;
    const { paypal, calls } = client();
    expect(paypal.sendingEnabled()).toBe(false);
    await expect(paypal.createBatch('org', 'batch-1', [{ senderItemId: 'l1', amountCents: 100, note: 'x', recipient: { recipient_type: 'EMAIL', receiver: 'a@b.c' } } as never]))
      .rejects.toMatchObject({ status: 423 });
    await expect(paypal.cancelItem('org', 'item-1')).rejects.toBeInstanceOf(PayPalError);
    expect(calls).toEqual([]);
  });

  it('still lets the real client read: the balance and the connection test', async () => {
    delete process.env.PAYPAL_PAYOUTS_ENABLED;
    const { paypal, calls } = client();
    await paypal.getBalance('org');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('refuses Send before any line moves, and says so on the run', async () => {
    delete process.env.PAYPAL_PAYOUTS_ENABLED;
    const touched: string[] = [];
    const never = (what: string) => async () => { touched.push(what); throw new Error(`${what} must not be reached`); };
    const prisma = {
      payoutRun: { findFirst: async () => ({ id: 'run', orgId: 'org', status: 'REVIEW', sendAttempt: 0 }), update: never('payoutRun.update') },
      payoutLine: { count: never('payoutLine.count'), updateMany: never('payoutLine.updateMany'), findMany: never('payoutLine.findMany') },
      $transaction: never('$transaction'),
    };
    const { paypal, calls } = client();
    const service = new PayoutRunService(prisma as never, {} as never, paypal, {} as never);
    await expect(service.send('org', 'run', 1, 'staff')).rejects.toMatchObject({ response: { code: 'PAYOUTS_LOCKED' } });
    expect([touched, calls]).toEqual([[], []]);
  });

  it('refuses cancelling an unclaimed payout, leaving the line as it was', async () => {
    delete process.env.PAYPAL_PAYOUTS_ENABLED;
    const updates: unknown[] = [];
    const prisma = {
      payoutLine: {
        findFirst: async () => ({ id: 'l1', status: 'UNCLAIMED', payoutItemId: 'item-1' }),
        update: async (x: unknown) => { updates.push(x); return x; },
      },
    };
    const { paypal, calls } = client();
    const nudges = new PayoutNudgeService(prisma as never, {} as never, {} as never, paypal, {} as never);
    await expect(nudges.cancelUnclaimed('org', 'l1', 'staff')).rejects.toBeInstanceOf(ForbiddenException);
    expect([updates, calls]).toEqual([[], []]);
  });
});
