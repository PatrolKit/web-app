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

function sellerVerificationTemplate(verifyUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Verify your email with PatrolKit</title></head>
<body style="font-family: Inter, 'Plus Jakarta Sans', sans-serif; background: #1a1a1a; color: #fff; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #252525; border-radius: 8px; padding: 40px;">
    <h1 style="color: #dc2626; font-size: 24px; margin: 0 0 8px;">PatrolKit</h1>
    <p style="color: #9ca3af; margin: 0 0 32px; font-size: 14px;">Ski swap management</p>
    <p style="margin: 0 0 8px; font-size: 18px; font-weight: 600;">Verify your email address</p>
    <p style="color: #9ca3af; margin: 0 0 24px; font-size: 14px;">Click the button below to confirm your email. This link expires in <strong style="color: #e5e7eb;">15 minutes</strong>.</p>
    <a href="${verifyUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">Verify Email</a>
    <p style="color: #6b7280; font-size: 13px; margin-top: 32px;">If you weren't expecting this, you can safely ignore this email.</p>
    <hr style="border: none; border-top: 1px solid #333; margin: 24px 0;">
    <p style="color: #4b5563; font-size: 12px; margin: 0;">Or copy this link: <span style="word-break: break-all; color: #9ca3af;">${verifyUrl}</span></p>
  </div>
</body>
</html>`;
}

function sellerAddedTemplate(signInUrl: string, orgName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>You've been added to a ski swap</title></head>
<body style="font-family: Inter, 'Plus Jakarta Sans', sans-serif; background: #1a1a1a; color: #fff; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #252525; border-radius: 8px; padding: 40px;">
    <h1 style="color: #dc2626; font-size: 24px; margin: 0 0 8px;">PatrolKit</h1>
    <p style="color: #9ca3af; margin: 0 0 32px; font-size: 14px;">Ski swap management</p>
    <p style="margin: 0 0 8px; font-size: 18px; font-weight: 600;">You've been added to a new ski swap!</p>
    <p style="color: #9ca3af; margin: 0 0 24px; font-size: 14px;"><strong style="color: #e5e7eb;">${orgName}</strong> has added you as a business seller. Sign in to manage your items.</p>
    <a href="${signInUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">Sign in to PatrolKit</a>
    <p style="color: #6b7280; font-size: 13px; margin-top: 32px;">If you weren't expecting this, you can safely ignore this email.</p>
  </div>
</body>
</html>`;
}

function sellerInviteTemplate(inviteUrl: string, orgName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>You're invited to sell on PatrolKit</title></head>
<body style="font-family: Inter, 'Plus Jakarta Sans', sans-serif; background: #1a1a1a; color: #fff; margin: 0; padding: 40px 20px;">
  <div style="max-width: 480px; margin: 0 auto; background: #252525; border-radius: 8px; padding: 40px;">
    <h1 style="color: #dc2626; font-size: 24px; margin: 0 0 8px;">PatrolKit</h1>
    <p style="color: #9ca3af; margin: 0 0 32px; font-size: 14px;">Ski swap management</p>
    <p style="margin: 0 0 8px; font-size: 18px; font-weight: 600;">You've been invited to participate in a ski swap!</p>
    <p style="color: #9ca3af; margin: 0 0 24px; font-size: 14px;"><strong style="color: #e5e7eb;">${orgName}</strong> has invited you to list your consignment items through PatrolKit.</p>
    <p style="margin: 0 0 24px; font-size: 14px;">Click the button below to set up your account and start managing your items. This invite link expires in <strong>30 days</strong>.</p>
    <a href="${inviteUrl}" style="display: inline-block; background: #dc2626; color: #fff; padding: 12px 28px; text-decoration: none; border-radius: 6px; font-weight: 600;">Accept Invitation</a>
    <p style="color: #6b7280; font-size: 13px; margin-top: 32px;">If you weren't expecting this invitation, you can safely ignore this email.</p>
    <hr style="border: none; border-top: 1px solid #333; margin: 24px 0;">
    <p style="color: #4b5563; font-size: 12px; margin: 0;">Or copy this link: <span style="word-break: break-all; color: #9ca3af;">${inviteUrl}</span></p>
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
    await this.send(to, subject, html);
  }

  async sendSellerInvite(to: string, inviteUrl: string, orgName: string): Promise<void> {
    const subject = `You've been invited to participate in a ski swap on PatrolKit`;
    const html = sellerInviteTemplate(inviteUrl, orgName);
    await this.send(to, subject, html);
  }

  async sendVerificationEmail(to: string, verifyUrl: string): Promise<void> {
    const subject = 'Verify your email address — PatrolKit';
    const html = sellerVerificationTemplate(verifyUrl);
    await this.send(to, subject, html);
  }

  async sendSellerAddedNotification(to: string, orgName: string): Promise<void> {
    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    const signInUrl = `${appUrl}/app/auth/login`;
    const subject = `You've been added to ${orgName} on PatrolKit`;
    const html = sellerAddedTemplate(signInUrl, orgName);
    await this.send(to, subject, html);
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.config.get<boolean>('app.outboundNotifications', false)) {
      this.logger.log({ to, subject }, '[mail suppressed] OUTBOUND_NOTIFICATIONS is off');
      return;
    }
    const from = this.config.get<string>('app.emailFrom', 'noreply@patrolkit.io');
    const transport = this.config.get<string>('app.mailTransport', 'smtp');
    try {
      if (transport === 'ses') {
        await this.sendViaSes(from, to, subject, html);
      } else {
        await this.sendViaSmtp(from, to, subject, html);
      }
      this.logger.log({ to, subject }, 'Email sent');
    } catch (err) {
      this.logger.error({ err, to }, 'Failed to send email');
      throw err;
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
