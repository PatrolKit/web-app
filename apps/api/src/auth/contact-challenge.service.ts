import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { SmsService } from '../sms/sms.service';
import { isUniqueViolation } from '../common/util/prisma-errors';
import type { SignInContext } from '../contracts/auth.contracts';
import { LIMITS } from '../common/limits/limits';
import { LimitUsageService } from '../common/limits/limit-usage.service';

export type ChallengeChannel = 'email' | 'phone';
/** `login` mints a session on confirm; `verify` only stamps; `invite` does both. */
export type ChallengePurpose = 'login' | 'verify' | 'invite';

const TTL_SECONDS: Record<ChallengePurpose, number> = {
  login: 15 * 60,
  verify: 15 * 60,
  invite: 30 * 24 * 60 * 60,
};

/**
 * Wrong guesses allowed per challenge. A new challenge starts a new count, so
 * this bounds guessing only together with the per-destination limit on issuing
 * them: 5 codes × 5 guesses per 15 minutes, from any number of addresses.
 */
const MAX_ATTEMPTS = 5;

/** The refusal registration and staff verification give at the limit. */
export const TOO_MANY_CODES = 'TOO_MANY_CODES';

/** Whether an error is `issue` refusing a destination that has had its share. */
export function isTooManyCodes(err: unknown): boolean {
  if (!(err instanceof HttpException)) return false;
  const body = err.getResponse();
  return typeof body === 'object' && body !== null && (body as { code?: unknown }).code === TOO_MANY_CODES;
}

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
    private readonly usage: LimitUsageService,
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
    /**
     * Validated by the caller before it gets here — an invalid pairing stored
     * now would fail at confirm, in a new tab, where there is nothing to do
     * about it.
     */
    context?: SignInContext;
    /**
     * What to do when this destination has had its share of codes.
     *
     * `refuse` is a 429 the caller can show. `decoy` is for sign-in, which must
     * never refuse visibly: unknown contacts create no rows and so are never
     * limited, and an honest refusal would announce that the account exists.
     * It answers exactly as an unknown contact is answered, and sends nothing.
     */
    whenLimited?: 'refuse' | 'decoy';
  }): Promise<IssuedChallenge> {
    const { userId, channel, target, purpose } = params;

    // Before superseding anything: a refused request must not also cancel the
    // code the person is holding.
    if (await this.destinationIsLimited(target, params.context)) {
      if (params.whenLimited === 'decoy') return { challengeId: createId(), channel };
      throw new HttpException(
        {
          message:
            `Too many codes have been sent to this ${channel === 'phone' ? 'number' : 'address'} ` +
            'recently. Try again in a few minutes.',
          code: TOO_MANY_CODES,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    /*
     * A new short code retires the old one: six digits are guessable, and two
     * live codes are twice the surface. A link is not — 32 random bytes — and
     * retiring it cost real sign-ins. Venue email is slow; a seller who tapped
     * "send" twice while waiting then opened the first message to arrive, and
     * it was dead. Every outstanding link stays good until it is used or it
     * expires, so whichever email lands first is the one that works.
     */
    if (channel === 'phone') {
      await this.prisma.contactChallenge.updateMany({
        where: { userId, channel, purpose, usedAt: null },
        data: { usedAt: new Date() },
      });
    }

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
        ...(params.context ? { context: params.context } : {}),
      },
    });

    await this.dispatch({
      challengeId: challenge.id,
      channel,
      target,
      rawCode,
      purpose,
      orgName: params.orgName,
      context: params.context,
      brand: await this.soleOrgOf(userId),
    });

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
   * Whether one more code to this destination would pass a limit (Plan 26 §5).
   *
   * Per destination rather than per address, because that is what bounds both
   * attacks: flooding one person, from however many addresses; and guessing
   * their code, where every new code brings five new guesses. Counted across
   * purposes, superseded codes included — they were sent.
   *
   * Counting then inserting is not atomic, so requests arriving together can
   * overshoot by however many arrive together. The limit bounds volume, not an
   * exact count.
   */
  private async destinationIsLimited(target: string, context?: SignInContext): Promise<boolean> {
    const now = Date.now();
    const checks = [
      { id: 'codes.perDestination', ...LIMITS['codes.perDestination'] },
      { id: 'codes.perDestinationDaily', ...LIMITS['codes.perDestinationDaily'] },
    ] as const;

    let limited = false;
    for (const check of checks) {
      const sent = await this.prisma.contactChallenge.count({
        where: { target, createdAt: { gte: new Date(now - check.windowMs) } },
      });
      const refused = sent >= check.limit;
      this.usage.record({
        limitId: check.id,
        hits: sent + 1,
        refused,
        keyKind: 'destination',
        where: 'ContactChallengeService.issue',
        // A sign-in names the swap it is for in its context, which the route
        // (`/auth/login`) does not.
        attribution: { swapId: context?.swapId },
      });
      limited ||= refused;
    }
    return limited;
  }

  /**
   * Verifies a code and stamps the contact verified. Returns the userId so the
   * caller can decide whether to mint a session.
   *
   * The verified value is mirrored into `verifiedEmail`/`verifiedPhone`, whose
   * unique index is what enforces "at most one person may hold a verified claim
   * to a contact". A rejection there means someone else already proved it.
   */
  async confirm(
    challengeId: string,
    rawCode: string,
  ): Promise<{ userId: string; purpose: ChallengePurpose; context: SignInContext | null }> {
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

    return {
      userId: challenge.userId,
      purpose: challenge.purpose as ChallengePurpose,
      // Scoped to the challenge: it dies with the row, so nothing about a
      // station outlives the sign-in that needed it.
      context: (challenge.context as SignInContext | null) ?? null,
    };
  }

  /**
   * The org to put at the top of a sign-in email, or nothing.
   *
   * Only when the person belongs to exactly one. With none there is nothing to
   * say, and with several there is no way to know which one they are signing in
   * to from here — the link is the same either way, and guessing would put one
   * club's name on a message about another's.
   *
   * Best-effort: a sign-in must not fail because branding could not be read.
   */
  private async soleOrgOf(userId: string): Promise<{ name: string; logoUrl: string | null } | undefined> {
    try {
      const memberships = await this.prisma.membership.findMany({
        where: { userId, deletedAt: null, org: { status: 'active' } },
        select: { org: { select: { name: true, logoUrl: true } } },
        take: 2,
      });
      if (memberships.length !== 1) return undefined;
      const org = memberships[0].org;
      return {
        name: org.name,
        // A `data:` URI is stripped by mail clients, so it is no logo at all
        // and the name stands on its own.
        logoUrl: org.logoUrl && /^https?:\/\//i.test(org.logoUrl) ? org.logoUrl : null,
      };
    } catch (err) {
      this.logger.error({ err, userId }, 'Could not resolve a sole org for sign-in branding');
      return undefined;
    }
  }

  private async dispatch(params: {
    challengeId: string;
    channel: ChallengeChannel;
    target: string;
    rawCode: string;
    purpose: ChallengePurpose;
    orgName?: string;
    context?: SignInContext;
    brand?: { name: string; logoUrl?: string | null };
  }): Promise<void> {
    const { challengeId, channel, target, rawCode, purpose, orgName, context } = params;

    if (channel === 'phone') {
      // Fire-and-forget, for the same reason as the mail call below: a delivery
      // failure must never surface as an auth error, which would leak whether
      // the account exists. `SmsService` used to absorb this itself, which made
      // the policy every later caller's problem — so it is stated here, where it
      // is actually wanted.
      const outcome = await this.sms.send(
        target, `Your PatrolKit code is: ${rawCode}. It expires in 15 minutes.`,
      );
      if (outcome.status === 'failed') {
        this.logger.error({ error: outcome.error }, 'Challenge SMS delivery failed');
      }
      return;
    }

    // The link has to open on the origin the person is actually standing on. A
    // seller checking in at a station is on skiswap.*, and a link back to the
    // staff app drops them somewhere they have no business being.
    const origin = context?.stationId
      ? this.config.get<string>('app.sellerSiteUrl', 'http://localhost:3000')
      : this.config.get<string>('app.appUrl', 'http://localhost:3000');
    /*
     * `p` is for the page's wording, and for nothing else.
     *
     * The verify page cannot tell a sign-in from a confirmation until it has
     * spent the challenge, so without this it greets everybody with "Sign in"
     * and only afterwards admits that some of them were confirming an address.
     * Tampering with it changes the sentence and nothing else: the server reads
     * the purpose off the challenge, and the outcome screen says what actually
     * happened.
     */
    const url =
      `${origin.replace(/\/$/, '')}/app/auth/verify?c=${challengeId}&t=${rawCode}` +
      (purpose === 'verify' ? '&p=verify' : '');

    // Fire-and-forget: delivery failure must never surface as an auth error,
    // which would leak whether the account exists.
    //
    // One branch per purpose. `verify` used to fall through to the sign-in
    // email, which promised a session it was never going to mint.
    const send =
      purpose === 'invite' && orgName
        ? this.mail.sendSellerInvite(target, url, orgName)
        : purpose === 'verify'
          ? this.mail.sendVerificationEmail(target, url, params.brand)
          : this.mail.sendMagicLink(target, url, params.brand);
    send.catch((err) => this.logger.error({ err }, 'Challenge email delivery failed'));
  }
}
