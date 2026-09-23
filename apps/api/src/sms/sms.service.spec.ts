import { Logger } from '@nestjs/common';
import { NOT_NORTH_AMERICAN, SmsService, TEXTING_PAUSED } from './sms.service';
import { LIMITS } from '../common/limits/limits';

/**
 * Where a text can go, and how many can go (Plan 26 §7).
 *
 * Notifications are off in every case here, so a text that passes both checks
 * reports the ordinary "switched off" suppression — which is how these tests
 * tell "stopped by a limit" apart from "would have gone".
 */
function build(sentThisHour: { codes: number; receipts: number }) {
  const prisma = {
    contactChallenge: { count: async () => sentThisHour.codes },
    receiptDelivery: { count: async () => sentThisHour.receipts },
  };
  const config = { get: (_k: string, d?: unknown) => d };
  const usage = { record: jest.fn() };
  return { sms: new SmsService(config as never, prisma as never, usage as never), usage };
}

const CEILING = LIMITS['sms.site'].limit;

describe('SmsService — where texts can go', () => {
  it('does not text a number outside the US and Canada', async () => {
    const { sms } = build({ codes: 0, receipts: 0 });
    await expect(sms.send('+442071234567', 'hi')).resolves.toEqual({ status: 'suppressed', reason: NOT_NORTH_AMERICAN });
    await expect(sms.canText('+442071234567')).resolves.toEqual({ ok: false, reason: NOT_NORTH_AMERICAN });
  });

  it('does not text a +1 number of the wrong length', async () => {
    const { sms } = build({ codes: 0, receipts: 0 });
    await expect(sms.canText('+1802555010')).resolves.toMatchObject({ ok: false });
  });

  it('lets a North American number through', async () => {
    const { sms } = build({ codes: 0, receipts: 0 });
    await expect(sms.canText('+18025550100')).resolves.toEqual({ ok: true });
    await expect(sms.send('+18025550100', 'hi')).resolves.toMatchObject({ reason: 'OUTBOUND_NOTIFICATIONS is off' });
  });
});

describe('SmsService — the site-wide ceiling', () => {
  it('pauses texting past the ceiling, counting codes and receipts together, and says so in the log', async () => {
    const { sms, usage } = build({ codes: CEILING - 100, receipts: 101 });
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(sms.send('+18025550100', 'hi')).resolves.toEqual({ status: 'suppressed', reason: TEXTING_PAUSED });
    expect(error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('ceiling'));
    expect(usage.record).toHaveBeenCalledWith(expect.objectContaining({ limitId: 'sms.site', refused: true }));
    error.mockRestore();
  });

  it('answers "paused" before anything is created that would need a text', async () => {
    const { sms } = build({ codes: CEILING, receipts: 0 });
    await expect(sms.canText('+18025550100')).resolves.toEqual({ ok: false, reason: TEXTING_PAUSED });
  });

  it('counts the code in hand once — its row already exists when it is sent', async () => {
    const { sms } = build({ codes: CEILING, receipts: 0 });
    await expect(sms.send('+18025550100', 'hi')).resolves.not.toMatchObject({ reason: TEXTING_PAUSED });
  });
});
