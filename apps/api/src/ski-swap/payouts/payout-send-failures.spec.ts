import { ConflictException } from '@nestjs/common';
import { HttpPayPalClient, PayPalError, existingPayoutBatchId, itemErrorText, paypalErrorInfo, type PayoutBatchResult } from './paypal.client';
import { PayoutRunService } from './payout-run.service';

/**
 * Send when PayPal doesn't simply say yes. The rule: a payment that may have
 * gone out is never released for a second one, and whatever PayPal said about
 * why is kept where a person, and PayPal's support, can read it.
 */

const saved = process.env.PAYPAL_PAYOUTS_ENABLED;
beforeEach(() => { process.env.PAYPAL_PAYOUTS_ENABLED = 'on'; });
afterEach(() => {
  if (saved === undefined) delete process.env.PAYPAL_PAYOUTS_ENABLED;
  else process.env.PAYPAL_PAYOUTS_ENABLED = saved;
});

describe('the PayPal client', () => {
  function client(answer: { status: number; body: unknown; debugId?: string }) {
    const posts: { url: string; headers: Record<string, string> }[] = [];
    global.fetch = jest.fn(async (url: string, init?: { headers?: Record<string, string> }): Promise<unknown> => {
      if (url.endsWith('/v1/oauth2/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }), text: async () => '{}', headers: new Headers() };
      }
      posts.push({ url, headers: init?.headers ?? {} });
      return {
        ok: answer.status < 300, status: answer.status, text: async () => JSON.stringify(answer.body),
        headers: new Headers(answer.debugId ? { 'paypal-debug-id': answer.debugId } : {}),
      };
    }) as unknown as typeof fetch;
    const prisma = { payPalConfig: { findUnique: async () => ({ clientId: 'id', clientSecretEnc: 'enc', environment: 'live' }) } };
    return { paypal: new HttpPayPalClient(prisma as never, { decrypt: () => 'secret' } as never), posts };
  }
  const item = { senderItemId: 'l1', amountCents: 100, note: 'x', recipient: { recipient_type: 'EMAIL', receiver: 'a@b.c' } } as never;

  it('sends the batch id as PayPal’s idempotency key, so a retry gets the payout PayPal already has', async () => {
    const { paypal, posts } = client({ status: 201, body: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } } });
    await paypal.createBatch('org', 'run-1', [item]);
    expect(posts[0].headers['PayPal-Request-Id']).toBe('run-1');
  });

  it('keeps PayPal’s error name, details and debug id on a refusal', async () => {
    const { paypal } = client({
      status: 422, debugId: 'dbg-123',
      body: { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.', details: [{ field: 'amount', issue: 'too much' }] },
    });
    const err = await paypal.createBatch('org', 'run-1', [item]).catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err.retryable).toBe(false);
    expect(err.info).toMatchObject({ name: 'INSUFFICIENT_FUNDS', debugId: 'dbg-123', details: ['amount: too much'] });
    expect(err.message).toContain('INSUFFICIENT_FUNDS: Sender does not have sufficient funds. (amount: too much)');
    expect(err.message).toContain('debug id dbg-123');
  });

  it('reads the debug id from the body when the header is missing, and survives a body that isn’t JSON', () => {
    expect(paypalErrorInfo('{"debug_id":"abc"}', null).debugId).toBe('abc');
    expect(paypalErrorInfo('<html>Bad gateway</html>', null)).toEqual({ name: undefined, message: undefined, details: [], debugId: undefined, links: [] });
  });

  it('finds the existing payout a duplicate batch id points to', () => {
    const err = new PayPalError('dup', 400, { details: [], links: ['https://api-m.paypal.com/v1/payments/payouts/5UXD2E8A7EBQJ'] });
    expect(existingPayoutBatchId(err)).toBe('5UXD2E8A7EBQJ');
    expect(existingPayoutBatchId(new PayPalError('x', 400, { details: [], links: ['https://www.paypal.com/docs/errors'] }))).toBeNull();
  });

  it('keeps a failed payment’s error code beside its message', () => {
    expect(itemErrorText({ name: 'RECEIVER_UNREGISTERED', message: 'Receiver is unregistered' })).toBe('Receiver is unregistered (RECEIVER_UNREGISTERED)');
    expect(itemErrorText({ name: 'RECEIVER_UNREGISTERED' })).toBe('RECEIVER_UNREGISTERED');
    expect(itemErrorText(undefined)).toBeUndefined();
  });
});

describe('Send again, after an attempt that didn’t come back', () => {
  /** A run with one payment already marked as sending, from an attempt PayPal never answered. */
  function resend(createBatch: () => Promise<PayoutBatchResult>, getBatch?: (orgId: string, id: string) => Promise<PayoutBatchResult>) {
    const run = { id: 'run', orgId: 'org', kind: 'PAYPAL', status: 'OPEN', sendAttempt: 1, payoutBatchId: null as string | null, batchReason: null as string | null, batchStatus: null as string | null };
    const line = { id: 'l1', runId: 'run', status: 'SENDING', destination: 'a@b.c', method: 'PAYPAL', destinationType: 'EMAIL', netCents: 4000, frozenAt: new Date() };
    const released: unknown[] = [];
    const prisma = {
      payoutRun: {
        findFirst: async (q: { where: { payoutBatchId?: string } }) => (q.where.payoutBatchId && q.where.payoutBatchId !== run.payoutBatchId ? null : run),
        findUnique: async () => ({ ...run, lines: [{ status: line.status }] }),
        update: async ({ data }: { data: Partial<typeof run> }) => Object.assign(run, data),
      },
      payoutLine: {
        count: async () => (line.status === 'SENDING' ? 1 : 0),
        findMany: async () => [line],
        findUnique: async () => line,
        updateMany: async ({ data }: { data: { status?: string } }) => {
          if (data.status === 'APPROVED') released.push(data);
          if (line.status === 'SENDING' && data.status) Object.assign(line, data);
          return { count: 1 };
        },
      },
      payoutLineItem: { deleteMany: async () => { released.push('items'); } },
      auditLog: { create: async () => ({}) },
      $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
    };
    const paypal = { sendingEnabled: () => true, createBatch: jest.fn(createBatch), getBatch: jest.fn(getBatch ?? (async () => { throw new Error('not expected'); })) };
    const service = new PayoutRunService(prisma as never, paypal as never, {} as never, {} as never);
    jest.spyOn(service, 'get').mockResolvedValue({} as never);
    return { service, run, line, released, paypal };
  }

  it('re-posts the same batch id, never a new one', async () => {
    const { service, paypal } = resend(async () => ({ batchId: 'B1', batchStatus: 'SUCCESS', items: [] }));
    await service.send('org', 'run', 1, 'staff');
    expect(paypal.createBatch).toHaveBeenCalledWith('org', 'run-1', expect.any(Array));
  });

  it('adopts the payout PayPal already has, and reads where it stands', async () => {
    const dup = new PayPalError('duplicate', 400, { name: 'DUPLICATE_REQUEST_ID', details: [], links: ['https://api-m.paypal.com/v1/payments/payouts/B9'] });
    const { service, run, line, released, paypal } = resend(
      async () => { throw dup; },
      async (_orgId, id) => ({ batchId: id, batchStatus: 'SUCCESS', items: [{ senderItemId: 'l1', payoutItemId: 'I1', transactionStatus: 'SUCCESS', transactionId: 'T1' }] }),
    );
    await service.send('org', 'run', 1, 'staff');
    expect(paypal.getBatch).toHaveBeenCalledWith('org', 'B9');
    expect([run.payoutBatchId, run.batchReason, line.status, released]).toEqual(['B9', null, 'SENT', []]);
  });

  it('keeps the payments sending when PayPal refuses the resend, and says why on the run', async () => {
    const { service, run, line, released } = resend(async () => {
      throw new PayPalError('PayPal POST /v1/payments/payouts failed: 403 NOT_AUTHORIZED [debug id d1]', 403, { name: 'NOT_AUTHORIZED', details: [], debugId: 'd1', links: [] });
    });
    await expect(service.send('org', 'run', 1, 'staff')).rejects.toBeInstanceOf(ConflictException);
    expect([line.status, released]).toEqual(['SENDING', []]);
    expect(run.batchReason).toContain('first attempt may have paid');
    expect(run.batchReason).toContain('debug id d1');
    expect(run.batchReason).toContain('run-1');
  });

  it('keeps the payments sending when PayPal still doesn’t answer, and records what went wrong', async () => {
    const { service, run, line, released } = resend(async () => { throw new PayPalError('PayPal POST /v1/payments/payouts failed: 503 SERVICE_UNAVAILABLE', 503); });
    await expect(service.send('org', 'run', 1, 'staff')).rejects.toBeInstanceOf(ConflictException);
    expect([line.status, released]).toEqual(['SENDING', []]);
    expect(run.batchReason).toContain('No answer from PayPal');
    expect(run.batchReason).toContain('503');
  });
});
