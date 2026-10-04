import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService, type SessionScope } from './jwt.service';
import { SignInPolicy } from '../common/identity/sign-in-policy.service';
import { RECEIPT_SIGN_IN_SELECT, receiptSignInEmail } from '../ski-swap/receipt-layout';
import { ContactChallengeService, type IssuedChallenge } from './contact-challenge.service';
import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import type { DeviceTokenResponse } from '../contracts/devices.contracts';
import type { SignInContext } from '../contracts/auth.contracts';
import { normalizeEmail, normalizePhone } from '../common/util/person';
import { SmsService } from '../sms/sms.service';

const REFRESH_COOKIE = 'refresh_token';

/** A check-in session lives a day (Plan 33 D6): long enough for one swap. */
const CHECKIN_SESSION_TTL_S = 24 * 60 * 60;

const SIGN_IN_CLOSED = {
  message: "Sign-in isn't open for sellers at this swap. To check in, scan the swap's check-in QR code.",
  code: 'SIGN_IN_CLOSED',
};

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly challenges: ContactChallengeService,
    private readonly config: ConfigService,
    private readonly sms: SmsService,
    private readonly policy: SignInPolicy,
  ) {}

  // ─── Login (email or phone) ──────────────────────────────────────────────────

  /**
   * Issues a login challenge on whichever channel was supplied.
   *
   * When nobody matches, this returns a *decoy*: a well-formed challenge id that
   * was never stored, so confirming it fails exactly like a wrong code. Callers
   * therefore cannot tell a real account from an absent one — returning null
   * here would make the response shape itself an enumeration oracle, which
   * matters most for the phone flow, where the client needs an id to confirm
   * against.
   */
  async requestLogin(input: {
    email?: string;
    phone?: string;
    receiptToken?: string;
    context?: SignInContext;
  }): Promise<IssuedChallenge | null> {
    // From a receipt's sign-in link (Plan 36): to that seller's verified email,
    // when the receipt's swap links there. Anything else is the usual decoy, so
    // a token can't be used to learn whether it means anything.
    if (input.receiptToken) {
      const email = await this.receiptSignInEmail(input.receiptToken);
      if (!email) return { challengeId: createId(), channel: 'email' };
      return this.requestLogin({ email });
    }

    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (!email && !phone) return null;

    // Texting off (Plan 29): a phone can't be sent a code. Refused before the
    // account lookup, so every number gets the same answer and none of them
    // says whether an account exists.
    if (!email && !(await this.sms.enabled())) {
      throw new BadRequestException({ message: 'Use your email to sign in.', code: 'SMS_OFF' });
    }

    // Before the decoy branch, so a bad context fails the same way for everyone
    // — checking it only for real accounts would make the error an oracle.
    if (input.context) await this.assertContextIsLive(input.context);

    const channel = email ? 'email' : 'phone';
    const user = await this.prisma.user.findFirst({
      where: email ? { email } : { phone: phone! },
    });
    if (!user) return { challengeId: createId(), channel };

    // Someone not allowed in gets exactly what an unknown address gets: a
    // decoy, and nothing sent (Plan 33 D7). Nothing tells whoever typed the
    // address that it belongs to a seller. Checking in at a station is never
    // refused; its session reaches the check-in flow only.
    if (!input.context && !(await this.policy.mayUseApp(user.id))) {
      return { challengeId: createId(), channel };
    }

    return this.challenges.issue({
      userId: user.id,
      channel,
      target: (email ?? phone)!,
      purpose: 'login',
      context: input.context,
      whenLimited: 'decoy',
    });
  }

  /**
   * The verified email a receipt's sign-in link sends to, or null when the
   * receipt shouldn't offer one: revoked, a swap that doesn't link to
   * sign-in, sign-in closed there, or no verified email (Plan 36 D3).
   */
  async receiptSignInEmail(token: string): Promise<string | null> {
    return receiptSignInEmail(await this.prisma.receipt.findUnique({ where: { token }, select: RECEIPT_SIGN_IN_SELECT }));
  }

  /**
   * Checks a sign-in context names things that exist right now.
   *
   * Validated here rather than at confirm because confirm often happens in a
   * different tab, minutes later, with the person already at the counter — the
   * wrong place to discover the station was retired.
   */
  private async assertContextIsLive(context: SignInContext): Promise<void> {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: context.swapId, active: true },
      select: { orgId: true },
    });
    if (!swap) throw new BadRequestException('This swap is not currently running');

    const station = await this.prisma.checkinStation.findFirst({
      where: { id: context.stationId, orgId: swap.orgId, deletedAt: null },
      select: { id: true },
    });
    if (!station) throw new BadRequestException('That check-in station is not set up');
  }

  /**
   * Confirms a challenge. Stamps the contact verified, and mints a session for
   * every purpose except a bare `verify`, which only proves the contact.
   */
  async confirmChallenge(
    challengeId: string,
    code: string,
    res: Response,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{ accessToken: string | null; verified: true; context: SignInContext | null }> {
    const { userId, purpose, context } = await this.challenges.confirm(challengeId, code);

    if (purpose === 'verify') return { accessToken: null, verified: true, context };

    // A sign-in at a station is a check-in session (Plan 33 D6). Any other is
    // checked again here: a link sent while sign-in was open may be opened
    // after it closed. The contact is still stamped verified; it was proven.
    const scope: SessionScope = context ? 'checkin' : 'full';
    if (scope === 'full' && !(await this.policy.mayUseApp(userId))) {
      throw new ForbiddenException(SIGN_IN_CLOSED);
    }

    const accessToken = await this.jwtService.signAccessToken(userId, scope);
    await this.issueRefreshCookie(userId, res, meta, { scope });
    return { accessToken, verified: true, context };
  }

  /** 30-day invite challenge for a newly-created business seller. */
  async createInviteChallenge(userId: string, email: string, orgName: string): Promise<void> {
    await this.challenges.issue({
      userId,
      channel: 'email',
      target: email,
      purpose: 'invite',
      orgName,
    });
  }

  // ─── Refresh rotation ────────────────────────────────────────────────────────

  async refresh(
    req: Request,
    res: Response,
    meta: { ipAddress?: string },
  ): Promise<{ accessToken: string }> {
    const rawToken: string | undefined = (req.cookies as Record<string, string>)[REFRESH_COOKIE];
    if (!rawToken) throw new UnauthorizedException('Missing refresh token');

    const tokenHash = sha256(rawToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!record || record.revokedAt || record.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token invalid or expired');
    }

    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date() },
    });

    // Turning a swap's sign-in off ends its sellers' sessions here, within an
    // access token's life (Plan 33). A check-in session keeps its scope and its
    // original expiry: rotating it doesn't make it last longer.
    const scope: SessionScope = record.scope === 'checkin' ? 'checkin' : 'full';
    if (scope === 'full' && !(await this.policy.mayUseApp(record.userId))) {
      this.clearRefreshCookie(res);
      throw new UnauthorizedException(SIGN_IN_CLOSED);
    }

    const accessToken = await this.jwtService.signAccessToken(record.userId, scope);
    await this.issueRefreshCookie(record.userId, res, meta, {
      scope,
      ...(scope === 'checkin' ? { expiresAt: record.expiresAt } : {}),
    });

    return { accessToken };
  }

  // ─── Logout ──────────────────────────────────────────────────────────────────

  async logout(req: Request, res: Response): Promise<void> {
    const rawToken: string | undefined = (req.cookies as Record<string, string>)[REFRESH_COOKIE];
    if (rawToken) {
      const tokenHash = sha256(rawToken);
      await this.prisma.refreshToken
        .updateMany({ where: { tokenHash, revokedAt: null }, data: { revokedAt: new Date() } })
        .catch(() => {
          /* best-effort */
        });
    }
    this.clearRefreshCookie(res);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async issueRefreshCookie(
    userId: string,
    res: Response,
    meta: { ipAddress?: string; userAgent?: string },
    session: { scope?: SessionScope; expiresAt?: Date } = {},
  ): Promise<void> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const scope = session.scope ?? 'full';
    const expiresAt = session.expiresAt ?? new Date(
      Date.now() + (scope === 'checkin' ? CHECKIN_SESSION_TTL_S : this.config.get<number>('app.refreshTokenTtl', 2592000)) * 1000,
    );
    const ttl = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
    const cookieDomain = this.config.get<string>('app.cookieDomain', '');
    const isProduction = this.config.get<string>('app.nodeEnv') === 'production';

    await this.prisma.refreshToken.create({
      data: {
        id: createId(),
        userId,
        tokenHash,
        expiresAt,
        scope,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });

    res.cookie(REFRESH_COOKIE, rawToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      maxAge: ttl * 1000,
      path: '/api/v1/auth',
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });
  }

  private clearRefreshCookie(res: Response): void {
    const cookieDomain = this.config.get<string>('app.cookieDomain', '');
    const isProduction = this.config.get<string>('app.nodeEnv') === 'production';
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
      path: '/api/v1/auth',
      ...(cookieDomain ? { domain: cookieDomain } : {}),
    });
  }

  // ─── Device token (delegated from controller) ────────────────────────────────

  /** A real argon2id hash of a secret nobody holds, made once. */
  private unknownDeviceHashing: Promise<string> | null = null;
  private unknownDeviceHash(argon2: typeof import('argon2')): Promise<string> {
    this.unknownDeviceHashing ??= argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id });
    return this.unknownDeviceHashing;
  }

  /**
   * A token for a device presenting its credentials.
   *
   * Three answers, kept apart because a device acts on each differently:
   *
   * - **401 `DEVICE_REVOKED`**: these credentials will never work again.
   *   Revoking deletes the device and rotating replaces its secret, and
   *   `clientId`s are minted here, so an unknown one or a secret that doesn't
   *   verify means exactly that. The device stops and asks to be provisioned.
   * - **500**: the check itself failed (argon2 out of memory, the database
   *   away). Nothing is known about the credentials, so the device retries.
   *   This used to come back as 401, which told a working iPad it had been
   *   revoked.
   * - **200**: a token.
   *
   * An unknown `clientId` is still checked against a real hash, so it costs
   * the same time as a wrong secret and says nothing about which it was.
   */
  async getDeviceToken(clientId: string, clientSecret: string): Promise<DeviceTokenResponse> {
    // Dynamic import to avoid circular dependency at module init time
    const argon2 = await import('argon2');
    const device = await this.prisma.device.findUnique({
      where: { clientId },
    });

    let valid: boolean;
    try {
      valid = await argon2.verify(device?.secretHash ?? (await this.unknownDeviceHash(argon2)), clientSecret);
    } catch (err) {
      this.logger.error({ err, clientId }, 'Device secret check failed');
      throw new InternalServerErrorException('Could not check this device’s credentials. Try again.');
    }

    if (!device || !valid) {
      // Logged with the clientId, which identifies but grants nothing: the
      // next time a device says it was refused, this is what answers why.
      this.logger.warn({ clientId, known: !!device }, 'Device token refused');
      throw new UnauthorizedException({
        message: 'This device has been removed from the organization, or its credentials were replaced. Provision it again.',
        code: 'DEVICE_REVOKED',
      });
    }

    // The role rides in the token: the print-job claim polls once a second, and
    // a lookup per request to ask what kind of device this is would be a
    // database round-trip for a constant. It goes stale for at most one token
    // lifetime, which is the price of not querying on every poll.
    const accessToken = await this.jwtService.signDeviceToken({
      sub: clientId,
      deviceId: device.id,
      orgId: device.orgId,
      role: device.role,
    });

    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    return { accessToken, tokenType: 'Bearer' };
  }
}
