import type { HttpException } from '@nestjs/common';
import { CheckinService } from './checkin.service';
import { SellerController } from './seller.controller';
import { SMS_OFF } from '../sms/sms.service';

/**
 * Self check-in and staff phone verification with texting off (Plan 29): a
 * phone is never sent a code, and the refusal says what to do instead.
 */

const textingOff = { canText: async () => ({ ok: false, reason: SMS_OFF }) };

function checkin() {
  const issued: { channel: string; target: string }[] = [];
  const people = {
    normalize: (i: { email?: string; phone?: string }) => ({ email: i.email ?? null, phone: i.phone ?? null }),
    resolveOrCreate: async () => ({ user: { id: 'u1' } }),
  };
  const challenges = { issue: async (i: { channel: string; target: string }) => { issued.push(i); return { challengeId: 'c1', channel: i.channel }; } };
  const unused = {} as never;
  const svc = new CheckinService(unused, people as never, challenges as never, unused, unused, unused, unused, textingOff as never);
  jest.spyOn(svc, 'context').mockResolvedValue({ swapId: 's1', stationId: 'st1' } as never);
  return { svc, issued };
}

describe('self check-in with texting off', () => {
  it('sends a phone-and-email seller an email link', async () => {
    const { svc, issued } = checkin();
    await svc.register('s1', 'st1', { phone: '+18025550100', email: 'dana@example.com' });
    expect(issued).toEqual([expect.objectContaining({ channel: 'email', target: 'dana@example.com' })]);
  });

  it('turns away a phone-only seller, asking for an email', async () => {
    const { svc, issued } = checkin();
    const err = await svc.register('s1', 'st1', { phone: '+18025550100' }).catch((e: HttpException) => e);
    expect((err as HttpException).getResponse()).toEqual({ message: 'Use your email to sign in.', code: 'CANNOT_TEXT' });
    expect(issued).toEqual([]);
  });
});

describe('staff verifying a phone with texting off', () => {
  it('is refused with a sentence, and nothing is issued', async () => {
    const issue = jest.fn();
    const sellers = { findOrThrow: async () => ({ membership: { userId: 'u1', user: { phone: '+18025550100', email: null } } }) };
    const controller = new SellerController(sellers as never, { issue } as never, textingOff as never, {} as never);
    const err = await controller.initiateVerification('org-1', 'seller-1', 'phone').catch((e: HttpException) => e);
    expect((err as HttpException).getResponse()).toEqual({ message: 'Texting is off. Verify their email.', code: 'CANNOT_TEXT' });
    expect(issue).not.toHaveBeenCalled();
  });
});

