import { ContactChallengeService } from './contact-challenge.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import type { SmsService } from '../sms/sms.service';
import type { ConfigService } from '@nestjs/config';
import type { LimitUsageService } from '../common/limits/limit-usage.service';
import type { MembershipTouchService } from '../common/identity/membership-touch.service';
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

const usage = { record: jest.fn() } as unknown as LimitUsageService;
const touch = { touchAllForUser: jest.fn() } as unknown as MembershipTouchService;

/**
 * `devCode` echoes a freshly-issued code straight back to the caller. That is a
 * developer convenience with nothing delivered — and an authentication bypass on
 * any reachable host. These tests pin the boundary.
 */
describe('ContactChallengeService — devCode exposure', () => {
  function build(env: { outbound: boolean; nodeEnv: string }) {
    const prisma = {
      contactChallenge: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'c1' }),
      },
    } as unknown as PrismaService;

    const config = {
      get: (key: string, fallback?: unknown) => {
        if (key === 'app.outboundNotifications') return env.outbound;
        if (key === 'app.nodeEnv') return env.nodeEnv;
        return fallback;
      },
    } as unknown as ConfigService;

    // Both services report a `SendOutcome` now. The stubs say `suppressed`
    // because that is what they model here — notifications are off in three of
    // the four cases below, and a stub that resolved `undefined` would only be
    // describing a signature neither service has.
    const suppressed = { status: 'suppressed' as const };
    const mail = {
      sendMagicLink: jest.fn().mockResolvedValue(suppressed),
    } as unknown as MailService;
    const sms = { send: jest.fn().mockResolvedValue(suppressed) } as unknown as SmsService;

    return new ContactChallengeService(prisma, mail, sms, config, usage, touch);
  }

  const issue = (svc: ContactChallengeService) =>
    svc.issue({ userId: 'u1', channel: 'phone', target: '+15550100000', purpose: 'login' });

  it('echoes the code in development when nothing was delivered', async () => {
    const res = await issue(build({ outbound: false, nodeEnv: 'development' }));
    expect(res.devCode).toMatch(/^\d{6}$/);
  });

  it('never echoes the code in production, even with notifications off', async () => {
    // The fail-closed switch must not become an authentication bypass.
    const res = await issue(build({ outbound: false, nodeEnv: 'production' }));
    expect(res.devCode).toBeUndefined();
  });

  it('never echoes the code when delivery actually happened', async () => {
    const res = await issue(build({ outbound: true, nodeEnv: 'development' }));
    expect(res.devCode).toBeUndefined();
  });

  it('always returns a challenge id, so the response shape is uniform', async () => {
    const res = await issue(build({ outbound: false, nodeEnv: 'production' }));
    expect(res.challengeId).toBe('c1');
    expect(res.channel).toBe('phone');
  });
});

/**
 * A magic link has to open on the origin the person is standing on. A seller
 * checking in at a station is on the seller site; the staff app is a different
 * host, and landing there is a dead end they cannot get out of.
 */
describe('ContactChallengeService — link origin', () => {
  function build() {
    const sent: string[] = [];
    const prisma = {
      contactChallenge: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockImplementation(({ data }: { data: unknown }) => {
          created.push(data);
          return Promise.resolve({ id: 'c1' });
        }),
      },
    } as unknown as PrismaService;
    const created: unknown[] = [];

    const config = {
      get: (key: string, fallback?: unknown) => {
        if (key === 'app.appUrl') return 'https://patrolkit.io';
        if (key === 'app.sellerSiteUrl') return 'https://skiswap.patrolkit.io';
        if (key === 'app.outboundNotifications') return true;
        if (key === 'app.nodeEnv') return 'production';
        return fallback;
      },
    } as unknown as ConfigService;

    const mail = {
      sendMagicLink: jest.fn().mockImplementation((_to: string, url: string) => {
        sent.push(url);
        return Promise.resolve();
      }),
    } as unknown as MailService;
    const sms = { send: jest.fn().mockResolvedValue(undefined) } as unknown as SmsService;

    return { svc: new ContactChallengeService(prisma, mail, sms, config, usage, touch), sent, created };
  }

  const base = { userId: 'u1', channel: 'email' as const, target: 'a@b.com', purpose: 'login' as const };

  it('sends an ordinary sign-in to the staff app', async () => {
    const { svc, sent } = build();
    await svc.issue(base);
    expect(sent[0].startsWith('https://patrolkit.io/app/auth/verify')).toBe(true);
  });

  it('sends a check-in sign-in to the seller site', async () => {
    const { svc, sent } = build();
    await svc.issue({ ...base, context: { swapId: 'swap1', stationId: 'station1' } });
    expect(sent[0].startsWith('https://skiswap.patrolkit.io/app/auth/verify')).toBe(true);
  });

  it('stores the context on the challenge, not in the link', async () => {
    const { svc, sent, created } = build();
    await svc.issue({ ...base, context: { swapId: 'swap1', stationId: 'station1' } });
    expect((created[0] as { context?: unknown }).context).toEqual({
      swapId: 'swap1',
      stationId: 'station1',
    });
    // Ids never travel in the query string — the link carries only the challenge.
    expect(sent[0]).not.toContain('station1');
    expect(sent[0]).not.toContain('swap1');
  });
});

/**
 * The iPads sync people by `Membership.updatedAt`. Verifying a contact writes
 * only the user, so unless every membership's watermark moves too, no delta
 * ever carries the verification to them.
 */
describe('ContactChallengeService — confirming a contact', () => {
  function build(opts: { duplicate?: boolean } = {}) {
    const challenge = {
      id: 'c1', userId: 'user-1', channel: 'email', target: 'dana@example.com', purpose: 'verify',
      codeHash: createHash('sha256').update('123456').digest('hex'), attempts: 0, usedAt: null,
      expiresAt: new Date(Date.now() + 60_000), context: null,
    };
    const userWrites: unknown[] = [];
    const prisma = {
      contactChallenge: {
        findUnique: jest.fn().mockResolvedValue(challenge),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { update: jest.fn((args: unknown) => { userWrites.push(args); return {}; }) },
      $transaction: jest.fn(async () => {
        if (opts.duplicate) throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
        return [];
      }),
    } as unknown as PrismaService;
    const touched: string[] = [];
    const touchAll = { touchAllForUser: jest.fn(async (id: string) => { touched.push(id); }) } as unknown as MembershipTouchService;
    const svc = new ContactChallengeService(prisma, {} as MailService, {} as SmsService, {} as ConfigService, usage, touchAll);
    return { svc, touched, userWrites };
  }

  it('moves the watermark of every membership the person holds', async () => {
    const { svc, touched, userWrites } = build();
    await svc.confirm('c1', '123456');
    expect(userWrites).toEqual([{ where: { id: 'user-1' }, data: expect.objectContaining({ verifiedEmail: 'dana@example.com' }) }]);
    expect(touched).toEqual(['user-1']);
  });

  it('moves nothing when the code is wrong', async () => {
    const { svc, touched } = build();
    await expect(svc.confirm('c1', '000000')).rejects.toThrow(/Invalid or expired code/);
    expect(touched).toEqual([]);
  });

  it('moves nothing when the contact is already someone else’s', async () => {
    const { svc, touched } = build({ duplicate: true });
    await expect(svc.confirm('c1', '123456')).rejects.toThrow(/already verified by another account/);
    expect(touched).toEqual([]);
  });
});
