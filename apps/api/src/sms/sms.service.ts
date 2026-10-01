import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { SendOutcome } from '../common/messaging/send-outcome';
import { PrismaService } from '../prisma/prisma.service';
import { LIMITS } from '../common/limits/limits';
import { LimitUsageService } from '../common/limits/limit-usage.service';
import { PlatformSettingsService } from '../platform/platform-settings.service';

/** A US or Canadian number, which is all a toll-free number can reach. */
const NORTH_AMERICAN = /^\+1\d{10}$/;

export const NOT_NORTH_AMERICAN = 'SMS is only sent to US and Canadian numbers';
export const TEXTING_PAUSED = 'Texting is paused';
/** The platform switch is off (Plan 29): nothing is texted, and nothing offers to. */
export const SMS_OFF = 'Texting is off';

export type TextAvailability =
  | { ok: true }
  | { ok: false; reason: typeof SMS_OFF | typeof NOT_NORTH_AMERICAN | typeof TEXTING_PAUSED };

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly usage: LimitUsageService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /** Whether texting is switched on, platform-wide (Plan 29). */
  enabled(): Promise<boolean> {
    return this.settings.smsEnabled();
  }

  /**
   * Whether a text to this number would go, asked before creating anything
   * that would need it to — registration chooses its channel with this.
   */
  async canText(to: string): Promise<TextAvailability> {
    if (!(await this.enabled())) return { ok: false, reason: SMS_OFF };
    if (!NORTH_AMERICAN.test(to)) return { ok: false, reason: NOT_NORTH_AMERICAN };
    if ((await this.sentThisHour()) >= LIMITS['sms.site'].limit) return { ok: false, reason: TEXTING_PAUSED };
    return { ok: true };
  }

  /**
   * Texts counted against the site-wide ceiling (Plan 26 §7): every phone code
   * and every texted receipt in the last hour, whatever became of them.
   *
   * From the rows rather than a counter in memory, so a restart does not hand
   * an attacker a fresh hour.
   */
  private async sentThisHour(): Promise<number> {
    const since = new Date(Date.now() - LIMITS['sms.site'].windowMs);
    const [codes, receipts] = await Promise.all([
      this.prisma.contactChallenge.count({ where: { channel: 'phone', createdAt: { gte: since } } }),
      this.prisma.receiptDelivery.count({ where: { channel: 'SMS', createdAt: { gte: since } } }),
    ]);
    return codes + receipts;
  }

  /**
   * Reports what happened rather than swallowing it.
   *
   * This used to log a failure and return normally, which was right for the
   * only caller it had — an OTP, where an auth error that depends on whether
   * delivery worked leaks whether the account exists. But that is a decision
   * about one caller, and keeping it here imposed it on every later one: a
   * receipt that reports success for a text which never left is worse than one
   * that fails loudly. The policy now lives at the call site that wants it, in
   * `ContactChallengeService.dispatch`, beside the mail call that always did.
   */
  async send(to: string, body: string): Promise<SendOutcome> {
    // The backstop for every caller that should have asked first (Plan 29).
    if (!(await this.enabled())) {
      this.logger.log({ to }, `[SMS suppressed] ${SMS_OFF}`);
      return { status: 'suppressed', reason: SMS_OFF };
    }

    /*
     * +1 only. A toll-free number cannot reach anywhere else anyway; this says
     * so rather than relying on the carrier, and keeps premium-rate
     * international numbers out of reach of anybody pumping texts for a cut.
     * Checked here rather than in `normalizePhone`, so an international
     * seller's number can still be stored and matched.
     */
    if (!NORTH_AMERICAN.test(to)) {
      this.logger.log({ to }, `[SMS suppressed] ${NOT_NORTH_AMERICAN}`);
      return { status: 'suppressed', reason: NOT_NORTH_AMERICAN };
    }

    /*
     * The site-wide ceiling. It limits how fast money can be spent; the AWS
     * spend limit, set by hand, limits how much. A code is counted from its row,
     * which exists by the time it is sent, so the one in hand is already in the
     * count — hence `>` rather than `>=`.
     */
    const sent = await this.sentThisHour();
    const paused = sent > LIMITS['sms.site'].limit;
    this.usage.record({
      limitId: 'sms.site', hits: sent, refused: paused, keyKind: 'site', where: 'SmsService.send',
    });
    if (paused) {
      this.logger.error({ sent, limit: LIMITS['sms.site'].limit }, 'SMS ceiling reached — texting is paused');
      return { status: 'suppressed', reason: TEXTING_PAUSED };
    }

    if (!this.config.get<boolean>('app.outboundNotifications', false)) {
      this.logger.log({ to, body }, '[SMS suppressed] OUTBOUND_NOTIFICATIONS is off');
      return { status: 'suppressed', reason: 'OUTBOUND_NOTIFICATIONS is off' };
    }
    const originationNumber = this.config.get<string>('app.snsOriginationNumber', '');
    if (!originationNumber) {
      this.logger.log(
        { to, body },
        '[SMS stub] AWS_SNS_ORIGINATION_NUMBER not set — logging instead of sending',
      );
      // Suppressed rather than sent: nothing left the building. Toll-free
      // registration is still pending, so this is the state every environment
      // is in today — production included — and it must not read as a delivery.
      // Distinguished from the gate above because they are not the same
      // problem: one is a switch, the other is a registration nobody here can
      // hurry.
      return { status: 'suppressed', reason: 'no SMS origination number is registered' };
    }
    const region = this.config.get<string>('app.awsRegion', 'us-east-2');
    const client = new SNSClient({ region });
    try {
      const res = await client.send(
        new PublishCommand({
          PhoneNumber: to,
          Message: body,
          MessageAttributes: {
            'AWS.SNS.SMS.OriginationNumber': {
              DataType: 'String',
              StringValue: originationNumber,
            },
            'AWS.SNS.SMS.SMSType': {
              DataType: 'String',
              StringValue: 'Transactional',
            },
          },
        }),
      );
      this.logger.log({ to, providerRef: res.MessageId }, 'SMS sent');
      return res.MessageId ? { status: 'sent', providerRef: res.MessageId } : { status: 'sent' };
    } catch (err) {
      this.logger.error({ err, to }, 'Failed to send SMS');
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }
}
