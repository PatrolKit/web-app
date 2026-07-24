import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

function magicLinkTemplate(magicLinkUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in to PatrolKit</title></head>
<body style="font-family: Inter, 'Plus Jakarta Sans', sans-serif; background: #1a1a1a; color: #fff; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #252525; border-radius: 8px; padding: 40px;">
    <h1 style="color: #dc2626; font-size: 24px; margin: 0 0 8px;">PatrolKit</h1>
    <p style="color: #9ca3af; margin: 0 0 32px; font-size: 14px;">Sign in to your account</p>
    <p style="margin: 0 0 24px;">Click the button below to sign in. This link expires in <strong>15 minutes</strong>.</p>
    <a href="${magicLinkUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">Sign in to PatrolKit</a>
    <p style="color: #6b7280; font-size: 13px; margin-top: 32px;">If you didn't request this, you can safely ignore this email.</p>
    <hr style="border: none; border-top: 1px solid #333; margin: 24px 0;">
    <p style="color: #4b5563; font-size: 12px; margin: 0;">Or copy this link: <span style="word-break: break-all; color: #9ca3af;">${magicLinkUrl}</span></p>
  </div>
</body>
</html>`;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  async sendMagicLink(to: string, magicLinkUrl: string): Promise<void> {
    const subject = 'Your sign-in link for PatrolKit';
    const html = magicLinkTemplate(magicLinkUrl);
    const from = this.config.get<string>('app.emailFrom', 'noreply@patrolkit.io');
    const transport = this.config.get<string>('app.mailTransport', 'smtp');

    try {
      if (transport === 'ses') {
        await this.sendViaSes(from, to, subject, html);
      } else {
        await this.sendViaSmtp(from, to, subject, html);
      }
      this.logger.log({ to, subject }, 'Magic-link email sent');
    } catch (err) {
      // Log error but never throw — the caller always gets a 200
      this.logger.error({ err, to }, 'Failed to send magic-link email');
    }
  }

  private async sendViaSes(
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const region = this.config.get<string>('app.sesRegion', 'us-east-2');
    const ses = new SESClient({ region });
    await ses.send(
      new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: { Html: { Data: html, Charset: 'UTF-8' } },
        },
      }),
    );
  }

  private async sendViaSmtp(
    from: string,
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const transporter = nodemailer.createTransport({
      host: this.config.get<string>('app.smtpHost', 'localhost'),
      port: this.config.get<number>('app.smtpPort', 1025),
      secure: false,
    });
    await transporter.sendMail({ from, to, subject, html });
  }
}
