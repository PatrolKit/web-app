import { PayoutNudgeService } from './payout-nudge.service';

/**
 * Payout reminders with texting off (Plan 29): email only. A seller reachable
 * only by text is recorded unreached, like one with no contact.
 */

const line = (id: string, user: { verifiedEmail: string | null; verifiedPhone: string | null }) => ({
  id, netCents: 4500, updatedAt: new Date(Date.now() - 40 * 86_400_000), notices: [],
  run: { orgId: 'org-1', swap: { title: 'Fall swap' } },
  seller: { membership: { org: { name: 'Org', logoUrl: null }, user: { ...user, firstName: 'Dana' } } },
});

function build(smsOn: boolean) {
  const notices: { channel: string; destination: string; error?: string }[] = [];
  const texts: string[] = [];
  const prisma = {
    payoutLine: {
      findMany: async () => [
        line('a', { verifiedEmail: 'a@example.com', verifiedPhone: '+18025550100' }),
        line('b', { verifiedEmail: null, verifiedPhone: '+18025550101' }),
      ],
    },
    payoutNotice: {
      create: async ({ data }: { data: { channel: string; destination: string; error?: string } }) => { notices.push(data); return data; },
    },
  };
  const mail = { sendPayoutNudge: async () => ({ status: 'sent' }) };
  const sms = { enabled: async () => smsOn, send: async (to: string) => { texts.push(to); return { status: 'sent' }; } };
  const config = { get: (_k: string, d?: unknown) => d };
  const svc = new PayoutNudgeService(prisma as never, mail as never, sms as never, {} as never, config as never);
  return { svc, notices, texts };
}

describe('payout reminders', () => {
  it('texts nobody while texting is off, and records the phone-only seller unreached', async () => {
    const { svc, notices, texts } = build(false);
    const res = await svc.sweep('org-1');
    expect(texts).toEqual([]);
    expect(res).toMatchObject({ sent: 1, failed: 1 });
    expect(notices.find((n) => n.destination === '')?.error).toMatch(/Texting is off/);
  });

  it('texts the phone-only seller while texting is on', async () => {
    const { svc, texts } = build(true);
    await svc.sweep('org-1');
    expect(texts).toEqual(['+18025550101']);
  });
});
