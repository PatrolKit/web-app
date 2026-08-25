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

    const mail = { sendMagicLink: jest.fn().mockResolvedValue(undefined) } as unknown as MailService;
    const sms = { send: jest.fn().mockResolvedValue(undefined) } as unknown as SmsService;

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
