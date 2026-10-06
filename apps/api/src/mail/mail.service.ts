import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import type { SendOutcome } from '../common/messaging/send-outcome';
import { emailShell } from './email-shell';
import { plainText } from './plain-text';
import { formatSender, PLATFORM_SENDER_NAME, senderAddress } from './sender';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from '../common/util/person';

/** An address on the `.invalid` domain, which is reserved for tests and can never receive mail. */
export function isReservedTestAddress(to: string): boolean {
  return /\.invalid\.?$/i.test(to.trim().split('@').pop() ?? '');
}

/** Whose sign-in this is, when the person belongs to exactly one org. */
export interface SignInBrand {
  name: string;
  logoUrl?: string | null;
}

function magicLinkTemplate(
  magicLinkUrl: string,
  brand: SignInBrand | undefined,
  markUrl: string,
): string {
  return emailShell({
    title: brand ? `Sign in to ${brand.name}` : 'Sign in to PatrolKit',
    // Led by the club where there is one, so the person sees the name they
    // recognise rather than the name of the software their club runs.
    brand,
    kicker: brand ? undefined : 'Sign in to your account',
    heading: 'Your sign-in link',
    body: ['Use the button below to sign in. This link expires in <strong>15 minutes</strong>.'],
    action: { label: brand ? `Sign in to ${brand.name}` : 'Sign in to PatrolKit', url: magicLinkUrl },
    footnote: "If you didn't request this, you can safely ignore this email.",
    showRawLink: true,
    // Only where somebody else's name is at the top; otherwise the header
    // already says PatrolKit.
    poweredByUrl: brand ? markUrl : null,
  });
}

/**
 * Confirming an address, which is not signing in.
 *
 * Both used to go out as the sign-in email, because `dispatch` only branched on
 * `invite` — so somebody asked to confirm an address received "Your sign-in
 * link", tapped "Sign in", and was told their contact was verified. This
 * template existed the whole time and nothing called it.
 *
 * Branded like the sign-in one, and for the same reason: staff at a counter ask
 * a seller to confirm an address, and the seller is expecting to hear from the
 * club rather than from the software the club runs.
 */
function verificationTemplate(
  verifyUrl: string,
  brand: SignInBrand | undefined,
  markUrl: string,
): string {
  return emailShell({
    title: brand ? `Confirm your email for ${brand.name}` : 'Confirm your email with PatrolKit',
    brand,
    kicker: brand ? undefined : 'Ski swap management',
    heading: 'Confirm your email address',
    body: [
      brand
        ? `<strong>${escapeHtml(brand.name)}</strong> needs to check this address belongs to you. ` +
          'Use the button below. This link expires in <strong>15 minutes</strong>.'
        : 'Use the button below to confirm this address belongs to you. This link expires in <strong>15 minutes</strong>.',
      // Said because the button is about to look exactly like a sign-in one,
      // and somebody who thinks they are signing in will wonder where they
      // ended up.
      'It only confirms the address — it does not sign you in.',
    ],
    action: { label: 'Confirm my email', url: verifyUrl },
    footnote: "If you weren't expecting this, you can safely ignore this email.",
    showRawLink: true,
    poweredByUrl: brand ? markUrl : null,
  });
}

function sellerAddedTemplate(signInUrl: string, orgName: string): string {
  return emailShell({
    title: "You've been added to a ski swap",
    kicker: 'Ski swap management',
    heading: "You've been added to a new ski swap",
    body: [
      `<strong>${orgName}</strong> has added you as a business seller. Sign in to manage your items.`,
    ],
    action: { label: 'Sign in to PatrolKit', url: signInUrl },
    footnote: "If you weren't expecting this, you can safely ignore this email.",
  });
}

/**
 * A member added to an org by an administrator, told where and how to sign in.
 *
 * Not a sign-in link: those expire in minutes, and this may sit in an inbox
 * for days before it's read. It points at the sign-in page, which asks for
 * this address and emails a fresh link each time.
 */
function memberInviteTemplate(signInUrl: string, orgName: string, email: string): string {
  return emailShell({
    title: `You've been added to ${orgName}`,
    kicker: orgName,
    heading: `You've been added to ${escapeHtml(orgName)} on PatrolKit`,
    body: [
      `<strong>${escapeHtml(orgName)}</strong> uses PatrolKit, and has added you to its team.`,
      `To sign in, open PatrolKit with the button below and enter <strong>${escapeHtml(email)}</strong>. ` +
        'We email you a link each time you sign in, so there is no password to remember.',
    ],
    action: { label: 'Sign in to PatrolKit', url: signInUrl },
    footnote: "If you weren't expecting this, you can safely ignore this email.",
    showRawLink: true,
  });
}

function sellerInviteTemplate(inviteUrl: string, orgName: string): string {
  return emailShell({
    title: "You're invited to sell on PatrolKit",
    kicker: 'Ski swap management',
    heading: "You've been invited to a ski swap",
    body: [
      `<strong>${orgName}</strong> has invited you to list your consignment items through PatrolKit.`,
      'Set up your account with the button below. This invite expires in <strong>30 days</strong>.',
    ],
    action: { label: 'Accept invitation', url: inviteUrl },
    footnote: "If you weren't expecting this invitation, you can safely ignore this email.",
    showRawLink: true,
  });
}

/** What a nudge needs to say. Assembled by `PayoutNudgeService` (Plan 25 §9). */
export interface PayoutNudge {
  orgName: string;
  orgLogoUrl: string | null;
  swapTitle: string;
  /** Already formatted — "$252.00". */
  amount: string;
  firstName: string | null;
  /** 7 or 21. Decides how much urgency the wording carries. */
  dayMark: number;
  claimUrl: string;
}

/**
 * "Your money is waiting, and here is how long you have."
 *
 * Deliberately specific about the deadline. An unclaimed PayPal payout returns
 * to the sender after thirty days, and a vague reminder that produces no action
 * costs the reader their money — so the second nudge says the date out loud.
 */
function payoutNudgeTemplate(n: PayoutNudge, markUrl: string): string {
  const daysLeft = Math.max(0, 30 - n.dayMark);
  const greeting = n.firstName ? `${escapeHtml(n.firstName)}, your` : 'Your';

  return emailShell({
    title: `Your ${escapeHtml(n.orgName)} payout is waiting`,
    brand: { name: n.orgName, logoUrl: n.orgLogoUrl },
    heading: `${greeting} payout is waiting to be claimed`,
    body: [
      `<strong>${escapeHtml(n.orgName)}</strong> sent you <strong>${escapeHtml(n.amount)}</strong> ` +
        `for what you sold at ${escapeHtml(n.swapTitle)}, but PayPal has not been able to deliver it.`,
      // The cause, in the two words that make it fixable. Almost every unclaimed
      // payout is an address with no PayPal account behind it, and the reader
      // is the only person who can tell us the right one.
      'This usually means the email address or phone number we have for you is not the one on your PayPal account.',
      daysLeft > 0
        ? `PayPal returns an unclaimed payment after 30 days. There are about <strong>${daysLeft} days</strong> left to collect this one.`
        : 'PayPal returns an unclaimed payment after 30 days, so please collect this one now.',
    ],
    action: { label: 'Check your payout details', url: n.claimUrl },
    footnote: `If the address is wrong, get in touch with ${escapeHtml(n.orgName)} and they can send it again.`,
    showRawLink: true,
    poweredByUrl: markUrl,
  });
}

/** The org's name and the swap's are user input, and they land inside markup. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async sendMagicLink(
    to: string,
    magicLinkUrl: string,
    brand?: SignInBrand,
  ): Promise<SendOutcome> {
    const subject = brand
      ? `Your sign-in link for ${brand.name}`
      : 'Your sign-in link for PatrolKit';
    return this.send(to, subject, magicLinkTemplate(magicLinkUrl, brand, this.brandMarkUrl()));
  }

  /**
   * The PatrolKit mark, absolute.
   *
   * 128px rather than the 1254px asset the web app uses at 14px: a mail client
   * fetches this on every open, and half a megabyte for something rendered at
   * fourteen pixels is a cost the recipient pays.
   */
  private brandMarkUrl(): string {
    const base = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    return `${base.replace(/\/$/, '')}/logo-mark.png`;
  }

  async sendSellerInvite(to: string, inviteUrl: string, orgName: string): Promise<SendOutcome> {
    const subject = `You've been invited to participate in a ski swap on PatrolKit`;
    const html = sellerInviteTemplate(inviteUrl, orgName);
    return this.send(to, subject, html);
  }

  async sendVerificationEmail(
    to: string,
    verifyUrl: string,
    brand?: SignInBrand,
  ): Promise<SendOutcome> {
    const subject = brand
      ? `Confirm your email for ${brand.name}`
      : 'Confirm your email address — PatrolKit';
    return this.send(to, subject, verificationTemplate(verifyUrl, brand, this.brandMarkUrl()));
  }

  /** "You've been added to <org> on PatrolKit", with where and how to sign in. Never expires. */
  async sendMemberInvite(to: string, orgName: string): Promise<SendOutcome> {
    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    const signInUrl = `${appUrl.replace(/\/$/, '')}/app/auth/login`;
    return this.send(to, `You've been added to ${orgName} on PatrolKit`, memberInviteTemplate(signInUrl, orgName, to));
  }

  async sendSellerAddedNotification(to: string, orgName: string): Promise<SendOutcome> {
    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    const signInUrl = `${appUrl}/app/auth/login`;
    const subject = `You've been added to ${orgName} on PatrolKit`;
    const html = sellerAddedTemplate(signInUrl, orgName);
    return this.send(to, subject, html);
  }

  /**
   * Reports rather than only throwing.
   *
   * Still throws, because every caller that predates receipts was written
   * against that and an auth path in particular treats a throw as its signal to
   * log and carry on. The outcome is for callers that have to write down what
   * happened — a suppressed send and a real one are indistinguishable otherwise
   * (see `SendOutcome`), and `failed` is returned as well as thrown so a caller
   * that catches still has the message.
   */
  /**
   * A receipt, whose body is built by `receipt-templates` rather than here.
   *
   * The other templates in this file are a heading and a button. A receipt is a
   * document with a variable-length table in it, and it is rendered from the
   * same `ReceiptView` the web page and the SMS use, so that the three cannot
   * disagree about what somebody dropped off.
   */
  async sendReceipt(to: string, orgName: string, html: string): Promise<SendOutcome> {
    return this.send(to, `Your ${orgName} ski swap receipt`, html);
  }

  async sendPayoutNudge(to: string, nudge: PayoutNudge): Promise<SendOutcome> {
    // The amount is in the subject on purpose. This is a message about money
    // the reader is owed, and it competes for attention with everything else in
    // an inbox weeks after a swap they have stopped thinking about.
    const subject = `${nudge.orgName}: your ${nudge.amount} payout is waiting`;
    return this.send(to, subject, payoutNudgeTemplate(nudge, this.brandMarkUrl()));
  }

  private async send(to: string, subject: string, html: string): Promise<SendOutcome> {
    // `.invalid` is reserved for tests (RFC 2606) and can never receive mail:
    // the test org's accounts use it. Sending would only bounce, and bounces
    // count against the sending account.
    if (isReservedTestAddress(to)) {
      this.logger.log({ to, subject }, '[mail suppressed] a .invalid test address');
      return { status: 'suppressed', reason: 'a .invalid test address, which can never receive mail' };
    }
    if (!this.config.get<boolean>('app.outboundNotifications', false)) {
      this.logger.log({ to, subject }, '[mail suppressed] OUTBOUND_NOTIFICATIONS is off');
      return { status: 'suppressed', reason: 'OUTBOUND_NOTIFICATIONS is off' };
    }
    const address = senderAddress(this.config.get<string>('app.emailFrom', 'noreply@patrolkit.io'));
    const from = formatSender(await this.senderName(to), address);
    const text = plainText(html);
    const transport = this.config.get<string>('app.mailTransport', 'smtp');
    try {
      const providerRef =
        transport === 'ses'
          ? await this.sendViaSes(from, to, subject, html, text)
          : await this.sendViaSmtp(from, to, subject, html, text);
      this.logger.log({ to, subject, providerRef }, 'Email sent');
      return providerRef ? { status: 'sent', providerRef } : { status: 'sent' };
    } catch (err) {
      this.logger.error({ err, to }, 'Failed to send email');
      throw err;
    }
  }

  /**
   * Who the mail says it is from: the recipient's club when they belong to
   * exactly one, otherwise PatrolKit (see `sender.ts`).
   *
   * Found by address, because that is all every caller has in common. An
   * address claimed by more than one person is treated like several clubs: the
   * name would be a guess.
   */
  private async senderName(to: string): Promise<string> {
    const email = normalizeEmail(to);
    if (!email) return PLATFORM_SENDER_NAME;
    try {
      const users = await this.prisma.user.findMany({
        where: { OR: [{ verifiedEmail: email }, { email }] },
        select: { id: true },
        take: 2,
      });
      if (users.length !== 1) return PLATFORM_SENDER_NAME;
      const memberships = await this.prisma.membership.findMany({
        where: { userId: users[0].id, deletedAt: null, org: { status: 'active' } },
        select: { org: { select: { name: true } } },
        take: 2,
      });
      return memberships.length === 1 ? memberships[0].org.name : PLATFORM_SENDER_NAME;
    } catch (err) {
      // A name is a nicety. Failing to find one must not stop the mail.
      this.logger.warn({ err }, 'Could not work out a sender name; using PatrolKit');
      return PLATFORM_SENDER_NAME;
    }
  }

  /** Returns the provider's id for the message, so a delivery row can name it. */
  private async sendViaSes(
    from: string,
    to: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<string | undefined> {
    const region = this.config.get<string>('app.sesRegion', 'us-east-2');
    const ses = new SESClient({ region });
    const res = await ses.send(
      new SendEmailCommand({
        Source: from,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Html: { Data: html, Charset: 'UTF-8' },
            Text: { Data: text, Charset: 'UTF-8' },
          },
        },
      }),
    );
    return res.MessageId;
  }

  private async sendViaSmtp(
    from: string,
    to: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<string | undefined> {
    const transporter = nodemailer.createTransport({
      host: this.config.get<string>('app.smtpHost', 'localhost'),
      port: this.config.get<number>('app.smtpPort', 1025),
      secure: false,
    });
    const info = await transporter.sendMail({ from, to, subject, html, text });
    return info.messageId;
  }
}
