import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { SendOutcome } from '../common/messaging/send-outcome';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

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
    if (!this.config.get<boolean>('app.outboundNotifications', false)) {
      this.logger.log({ to, body }, '[SMS suppressed] OUTBOUND_NOTIFICATIONS is off');
      return { status: 'suppressed' };
    }
    const originationNumber = this.config.get<string>('app.snsOriginationNumber', '');
    if (!originationNumber) {
      this.logger.log(
        { to, body },
        '[SMS stub] AWS_SNS_ORIGINATION_NUMBER not set — logging instead of sending',
      );
      // Suppressed rather than sent: nothing left the building. Toll-free
      // registration is still pending, so this is the state every environment
      // is in today and it must not read as a delivery.
      return { status: 'suppressed' };
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
