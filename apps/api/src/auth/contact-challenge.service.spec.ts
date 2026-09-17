import { ContactChallengeService } from './contact-challenge.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import type { SmsService } from '../sms/sms.service';
import type { ConfigService } from '@nestjs/config';

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

    return new ContactChallengeService(prisma, mail, sms, config);
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

    return { svc: new ContactChallengeService(prisma, mail, sms, config), sent, created };
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
