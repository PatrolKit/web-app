import type { HttpException } from '@nestjs/common';
import { ContactChallengeService, isTooManyCodes } from './contact-challenge.service';
import { AuthService } from './auth.service';
import { LimitUsageService } from '../common/limits/limit-usage.service';
import type { AttributionResolver } from '../common/limits/attribution-resolver.service';

const MINUTE = 60_000;
const PHONE = '+18025550100';

/**
 * Codes are limited per destination (Plan 26 §5): at most 5 in 15 minutes and
 * 10 in a day to one phone number or address, whoever asks and from wherever.
 *
 * The fake table counts the way the query does — by target and age — and keeps
 * superseded rows, because the real one does.
 */
function harness() {
  const smsOn = { value: true };
  const rows: { id: string; target: string; createdAt: Date; usedAt: Date | null }[] = [];
  const sent: string[] = [];
  const written: unknown[] = [];

  const prisma = {
    contactChallenge: {
      count: async ({ where }: { where: { target: string; createdAt: { gte: Date } } }) =>
        rows.filter((r) => r.target === where.target && r.createdAt >= where.createdAt.gte).length,
      updateMany: jest.fn(async ({ data }: { data: { usedAt: Date } }) => {
        for (const r of rows) r.usedAt ??= data.usedAt;
        return { count: rows.length };
      }),
      create: async ({ data }: { data: { id: string; target: string } }) => {
        rows.push({ id: data.id, target: data.target, createdAt: new Date(), usedAt: null });
        return { id: data.id };
      },
    },
    membership: { findMany: async () => [] },
    user: { findFirst: async ({ where }: { where: { phone?: string } }) => (where.phone === PHONE ? { id: 'u1' } : null) },
    $executeRaw: async (sql: unknown) => { written.push(sql); return 1; },
    limitUsage: { deleteMany: async () => ({ count: 0 }) },
  };
  const config = {
    get: (k: string, d?: unknown) =>
      ({ 'app.outboundNotifications': true, 'app.nodeEnv': 'production' })[k] ?? d,
  };
  const sms = { enabled: async () => smsOn.value, send: async (to: string) => { sent.push(to); return { status: 'sent' }; } };
  const mail = { sendMagicLink: async (to: string) => { sent.push(to); return { status: 'sent' }; } };
  const resolver = { resolve: async () => ({ orgId: '', swapId: '' }) } as unknown as AttributionResolver;
  const usage = new LimitUsageService(prisma as never, resolver);

  const challenges = new ContactChallengeService(prisma as never, mail as never, sms as never, config as never, usage, {} as never);
  const auth = new AuthService(prisma as never, {} as never, challenges, config as never, sms as never);

  const issue = (target = PHONE, whenLimited?: 'refuse' | 'decoy') =>
    challenges.issue({ userId: 'u1', channel: 'phone', target, purpose: 'verify', whenLimited });
  const backdate = (target: string, count: number, ageMs: number) => {
    for (let i = 0; i < count; i++) {
      rows.push({ id: `old-${rows.length}`, target, createdAt: new Date(Date.now() - ageMs), usedAt: new Date() });
    }
  };

  return { rows, sent, written, usage, challenges, auth, issue, backdate, prisma, smsOn };
}

describe('codes, per destination', () => {
  it('refuses the sixth code to one destination inside 15 minutes, openly', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.issue();
    const refusal = await h.issue().catch((e: HttpException) => e);
    expect(isTooManyCodes(refusal)).toBe(true);
    expect((refusal as HttpException).getStatus()).toBe(429);
    expect(h.sent).toHaveLength(5);
  });

  it('leaves another destination unaffected', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.issue();
    await expect(h.issue('+18025550199')).resolves.toMatchObject({ channel: 'phone' });
  });

  it('counts superseded codes, because they were sent', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.issue();
    // Every one but the last is superseded by now.
    expect(h.rows.filter((r) => r.usedAt)).toHaveLength(4);
    await expect(h.issue()).rejects.toMatchObject({ status: 429 });
  });

  it('forgets codes older than the window', async () => {
    const h = harness();
    h.backdate(PHONE, 4, 16 * MINUTE);
    await expect(h.issue()).resolves.toMatchObject({ channel: 'phone' });
  });

  it('holds the daily limit even when the last 15 minutes are quiet', async () => {
    const h = harness();
    h.backdate(PHONE, 10, 3 * 60 * MINUTE);
    await expect(h.issue()).rejects.toMatchObject({ status: 429 });
  });

  it('does not cancel the code the person is holding when it refuses', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.issue();
    h.prisma.contactChallenge.updateMany.mockClear();
    await h.issue().catch(() => undefined);
    expect(h.prisma.contactChallenge.updateMany).not.toHaveBeenCalled();
    expect(h.rows.filter((r) => !r.usedAt)).toHaveLength(1);
  });
});

describe('a limited sign-in', () => {
  it('answers exactly as an unknown contact is answered, and sends nothing', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.issue();
    h.sent.length = 0;
    const rowsBefore = h.rows.length;

    const limited = await h.auth.requestLogin({ phone: PHONE });
    const unknown = await h.auth.requestLogin({ phone: '+18025550142' });

    // Compared against the real decoy, not a hand-written idea of one.
    expect(Object.keys(limited!).sort()).toEqual(Object.keys(unknown!).sort());
    expect(limited!.channel).toBe(unknown!.channel);
    expect(limited!.challengeId).toMatch(/^[a-z0-9]{20,}$/);
    expect(h.rows.find((r) => r.id === limited!.challengeId)).toBeUndefined();
    expect(h.rows).toHaveLength(rowsBefore);
    expect(h.sent).toHaveLength(0);
  });
});

describe('signing in by phone with texting off (Plan 29)', () => {
  it('refuses a known and an unknown number alike, before looking either up', async () => {
    const h = harness();
    h.smsOn.value = false;
    const lookup = jest.spyOn(h.prisma.user, 'findFirst');
    const known = await h.auth.requestLogin({ phone: PHONE }).catch((e: HttpException) => e);
    const unknown = await h.auth.requestLogin({ phone: '+18025550142' }).catch((e: HttpException) => e);
    for (const e of [known, unknown]) {
      expect((e as HttpException).getStatus()).toBe(400);
      expect((e as HttpException).getResponse()).toEqual({ message: 'Use your email to sign in.', code: 'SMS_OFF' });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(0);
  });
});

describe('what the health record keeps', () => {
  it('never writes the destination — only how far it got', async () => {
    const h = harness();
    for (let i = 0; i < 7; i++) await h.issue().catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    await h.usage.flush();

    // Every value bound into every statement, as the database would see it.
    const values = (h.written as { values: unknown[] }[]).flatMap((sql) => sql.values).map(String);
    expect(values).toContain('codes.perDestination');
    expect(values.filter((v) => v.includes('8025550100'))).toEqual([]);
  });
});
