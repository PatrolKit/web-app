import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';

export type ChallengeChannel = 'email' | 'phone';
/** `login` mints a session on confirm; `verify` only stamps; `invite` does both. */
export type ChallengePurpose = 'login' | 'verify' | 'invite';

const TTL_SECONDS: Record<ChallengePurpose, number> = {
  login: 15 * 60,
  verify: 15 * 60,
  invite: 30 * 24 * 60 * 60,
};

/** A 6-digit OTP is guessable; the IP throttle alone does not bound a distributed attempt. */
const MAX_ATTEMPTS = 5;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface IssuedChallenge {
  challengeId: string;
  channel: ChallengeChannel;
  /**
   * The raw code, echoed back so a developer can complete the flow with nothing
   * delivered. Populated only OUTSIDE production — on a reachable host this
   * would let anyone sign in as anyone.
   */
  devCode?: string;
}

/**
 * The single primitive for proving control of a contact channel. Replaces the
 * old MagicLink (email tokens) and SellerVerification (email tokens + phone
 * OTPs) tables.
 *
 * Lookup is always by challenge id, never by code hash: a 32-byte email token
 * and a 6-digit OTP share this table, and a unique index on the hash cannot
 * work for OTPs.
 */
@Injectable()
export class ContactChallengeService {
  private readonly logger = new Logger(ContactChallengeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly sms: SmsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Issues a challenge and dispatches it. Supersedes any outstanding challenge
   * for the same (user, channel, purpose) so an old code cannot be replayed.
   */
  async issue(params: {
    userId: string;
    channel: ChallengeChannel;
    target: string;
    purpose: ChallengePurpose;
    orgName?: string;
  }): Promise<IssuedChallenge> {
    const { userId, channel, target, purpose } = params;

    await this.prisma.contactChallenge.updateMany({
      where: { userId, channel, purpose, usedAt: null },
      data: { usedAt: new Date() },
    });

    // Email proves control of a link; phone proves control of a short code.
    const rawCode =
      channel === 'email'
        ? randomBytes(32).toString('hex')
        : String(Math.floor(100000 + Math.random() * 900000));

    const challenge = await this.prisma.contactChallenge.create({
      data: {
        id: createId(),
        userId,
        channel,
        target,
        purpose,
        codeHash: sha256(rawCode),
        expiresAt: new Date(Date.now() + TTL_SECONDS[purpose] * 1000),
      },
    });

    await this.dispatch(challenge.id, channel, target, rawCode, purpose, params.orgName);

    // Two independent conditions, deliberately. Suppression says nothing was
    // delivered; non-production says it is safe to say what the code was. A
    // production host with notifications off stays silent rather than handing
    // out credentials — otherwise the fail-closed switch would itself become an
    // authentication bypass.
    const suppressed = !this.config.get<boolean>('app.outboundNotifications', false);
    const isProduction = this.config.get<string>('app.nodeEnv') === 'production';
    return {
      challengeId: challenge.id,
      channel,
      ...(suppressed && !isProduction ? { devCode: rawCode } : {}),
    };
  }

  /**
   * Verifies a code and stamps the contact verified. Returns the userId so the
   * caller can decide whether to mint a session.
   *
   * The verified value is mirrored into `verifiedEmail`/`verifiedPhone`, whose
   * unique index is what enforces "at most one person may hold a verified claim
   * to a contact". A rejection there means someone else already proved it.
   */
  async confirm(challengeId: string, rawCode: string): Promise<{ userId: string; purpose: ChallengePurpose }> {
    const challenge = await this.prisma.contactChallenge.findUnique({ where: { id: challengeId } });

    if (!challenge || challenge.usedAt || challenge.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired code');
    }
    if (challenge.attempts >= MAX_ATTEMPTS) {
      throw new BadRequestException('Too many attempts — request a new code');
    }

    if (challenge.codeHash !== sha256(rawCode)) {
      await this.prisma.contactChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException('Invalid or expired code');
    }

    const now = new Date();
    const stamp =
      challenge.channel === 'email'
        ? { emailVerifiedAt: now, verifiedEmail: challenge.target }
        : { phoneVerifiedAt: now, verifiedPhone: challenge.target };

    try {
      await this.prisma.$transaction([
        this.prisma.contactChallenge.update({
          where: { id: challenge.id },
          data: { usedAt: now },
        }),
        this.prisma.user.update({ where: { id: challenge.userId }, data: stamp }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new BadRequestException(
          'That contact is already verified by another account. Contact support to merge them.',
        );
      }
      throw err;
    }

    return { userId: challenge.userId, purpose: challenge.purpose as ChallengePurpose };
  }

  private async dispatch(
    challengeId: string,
    channel: ChallengeChannel,
    target: string,
    rawCode: string,
    purpose: ChallengePurpose,
    orgName?: string,
  ): Promise<void> {
    if (channel === 'phone') {
      await this.sms.send(target, `Your PatrolKit code is: ${rawCode}. It expires in 15 minutes.`);
      return;
    }

    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    const url = `${appUrl}/app/auth/verify?c=${challengeId}&t=${rawCode}`;

    // Fire-and-forget: delivery failure must never surface as an auth error,
    // which would leak whether the account exists.
    const send =
      purpose === 'invite' && orgName
        ? this.mail.sendSellerInvite(target, url, orgName)
        : this.mail.sendMagicLink(target, url);
    send.catch((err) => this.logger.error({ err }, 'Challenge email delivery failed'));
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}
