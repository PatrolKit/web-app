import { PayoutRunService } from './payout-run.service';
import { PayoutNudgeService } from './payout-nudge.service';

/**
 * An unclaimed payment's reminders count days from when it went unclaimed
 * (its `updatedAt`). A Check or a repeated webhook that brings no news must
 * leave it alone, or each one restarts the count. And the hourly sweep nudges
 * only sellers paid through live PayPal.
 */

const item = (over: Record<string, unknown> = {}) => ({
  senderItemId: 'line-1', transactionStatus: 'UNCLAIMED', payoutItemId: 'PI1', transactionId: 'TX1', errorMessage: null, ...over,
});

function runService(before: Record<string, unknown>) {
  const writes: unknown[] = [];
  const prisma = {
    payoutLine: {
      findUnique: async () => ({ runId: 'run-1', frozenAt: new Date(), ...before }),
      updateMany: async (args: unknown) => { writes.push(args); return { count: 1 }; },
    },
    payoutRun: { findUnique: async () => null, findFirst: async () => null },
  };
  return { svc: new PayoutRunService(prisma as never, {} as never, {} as never, {} as never), writes };
}

describe('PayPal news on an unclaimed payment', () => {
  it('writes nothing when the status and ids are what we already have', async () => {
    const { svc, writes } = runService({ status: 'UNCLAIMED', payoutItemId: 'PI1', transactionId: 'TX1' });
    await svc.applyBatchResult('B1', [item()] as never, { source: 'check' });
    expect(writes).toEqual([]);
  });

  it('still fills in an id PayPal gives for the first time', async () => {
    const { svc, writes } = runService({ status: 'UNCLAIMED', payoutItemId: 'PI1', transactionId: null });
    await svc.applyBatchResult('B1', [item()] as never, { source: 'check' });
    expect(writes).toHaveLength(1);
  });

  it('writes a change of status', async () => {
    const { svc, writes } = runService({ status: 'UNCLAIMED', payoutItemId: 'PI1', transactionId: 'TX1' });
    await svc.applyBatchResult('B1', [item({ transactionStatus: 'SUCCESS' })] as never, { source: 'webhook' });
    expect(writes).toHaveLength(1);
  });
});

describe('the hourly nudge sweep', () => {
  it('sweeps only orgs on live PayPal', async () => {
    const swept: string[] = [];
    const prisma = {
      payPalConfig: { findMany: async ({ where }: { where: { environment: string } }) => (where.environment === 'live' ? [{ orgId: 'live-org' }] : [{ orgId: 'sandbox-org' }]) },
    };
    const svc = new PayoutNudgeService(prisma as never, {} as never, {} as never, {} as never, {} as never);
    svc.sweep = async (orgId: string) => { swept.push(orgId); return { considered: 0, sent: 0, suppressed: 0, failed: 0, skipped: 0 }; };
    await svc.sweepLive();
    expect(swept).toEqual(['live-org']);
  });
});
