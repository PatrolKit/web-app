import { PatrollerService } from './patroller.service';

/**
 * Onboarding codes with texting off (Plan 29): a patroller known only by a
 * phone is skipped, and one with an email is still sent a link.
 */

const row = (id: string, user: { email: string | null; phone: string | null }) => ({
  id, membership: { userId: `u-${id}`, user: { ...user, emailVerifiedAt: null, phoneVerifiedAt: null } },
});
const ROWS = [
  row('a', { email: 'a@example.com', phone: '+18025550100' }),
  row('b', { email: null, phone: '+18025550101' }),
];

function build(smsOn: boolean) {
  const issued: { channel: string; target: string }[] = [];
  const prisma = { patrollerProfile: { findMany: async () => ROWS } };
  const challenges = { issue: async (i: { channel: string; target: string }) => { issued.push(i); return {}; } };
  const sms = { enabled: async () => smsOn };
  const unused = {} as never;
  const svc = new PatrollerService(prisma as never, unused, unused, unused, challenges as never, sms as never);
  return { svc, issued };
}

describe('onboarding', () => {
  it('skips a phone-only patroller while texting is off', async () => {
    const { svc, issued } = build(false);
    await expect(svc.sendOnboarding('org-1')).resolves.toEqual({ sent: 1, skipped: 1 });
    expect(issued).toEqual([expect.objectContaining({ channel: 'email', target: 'a@example.com' })]);
  });

  it('texts them while texting is on', async () => {
    const { svc, issued } = build(true);
    await expect(svc.sendOnboarding('org-1')).resolves.toEqual({ sent: 2, skipped: 0 });
    expect(issued.map((i) => i.channel)).toEqual(['email', 'phone']);
  });
});
