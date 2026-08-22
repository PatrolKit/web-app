import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly config: ConfigService) {}

  async send(to: string, body: string): Promise<void> {
    const originationNumber = this.config.get<string>('app.snsOriginationNumber', '');
    if (!originationNumber) {
      this.logger.log({ to, body }, '[SMS stub] AWS_SNS_ORIGINATION_NUMBER not set — logging instead of sending');
      return;
    }
    const region = this.config.get<string>('app.awsRegion', 'us-east-2');
    const client = new SNSClient({ region });
    try {
      await client.send(
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
      this.logger.log({ to }, 'SMS sent');
    } catch (err) {
      this.logger.error({ err, to }, 'Failed to send SMS');
    }
  }
}
