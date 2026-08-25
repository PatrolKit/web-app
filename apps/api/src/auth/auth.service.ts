import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from './jwt.service';
import { ContactChallengeService, type IssuedChallenge } from './contact-challenge.service';
import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import type { DeviceTokenResponse } from '../contracts/devices.contracts';
import { normalizeEmail, normalizePhone } from '../common/util/person';

const REFRESH_COOKIE = 'refresh_token';

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
  ) {}

  // ─── Login (email or phone) ──────────────────────────────────────────────────

  /**
   * Issues a login challenge on whichever channel was supplied. Always resolves,
   * whether or not the person exists — an error here would leak account
   * existence. Returns null when there is nothing to send to.
   */
  async requestLogin(input: { email?: string; phone?: string }): Promise<IssuedChallenge | null> {
    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    if (!email && !phone) return null;

    const user = await this.prisma.user.findFirst({
      where: email ? { email } : { phone: phone! },
    });
    if (!user) return null;

    return this.challenges.issue({
      userId: user.id,
      channel: email ? 'email' : 'phone',
      target: (email ?? phone)!,
      purpose: 'login',
    });
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
  ): Promise<{ accessToken: string | null; verified: true }> {
    const { userId, purpose } = await this.challenges.confirm(challengeId, code);

    if (purpose === 'verify') return { accessToken: null, verified: true };

    const accessToken = await this.jwtService.signAccessToken(userId);
    await this.issueRefreshCookie(userId, res, meta);
    return { accessToken, verified: true };
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

    const accessToken = await this.jwtService.signAccessToken(record.userId);
    await this.issueRefreshCookie(record.userId, res, meta);

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
  ): Promise<void> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const ttl = this.config.get<number>('app.refreshTokenTtl', 2592000);
    const expiresAt = new Date(Date.now() + ttl * 1000);
    const cookieDomain = this.config.get<string>('app.cookieDomain', '');
    const isProduction = this.config.get<string>('app.nodeEnv') === 'production';

    await this.prisma.refreshToken.create({
      data: {
        id: createId(),
        userId,
        tokenHash,
        expiresAt,
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

  async getDeviceToken(clientId: string, clientSecret: string): Promise<DeviceTokenResponse> {
    // Dynamic import to avoid circular dependency at module init time
    const argon2 = await import('argon2');
    const device = await this.prisma.device.findUnique({
      where: { clientId },
      include: { permissions: { include: { permission: true } } },
    });

    const hash = device?.secretHash ?? '$argon2id$v=19$m=65536,t=3,p=4$placeholder';
    const valid = await argon2.verify(hash, clientSecret).catch(() => false);

    if (!device || !valid) {
      throw new UnauthorizedException('Invalid device credentials');
    }

    const permissions = device.permissions.map((dp) => dp.permission.key);
    const accessToken = await this.jwtService.signDeviceToken({
      sub: clientId,
      deviceId: device.id,
      orgId: device.orgId,
      permissions,
    });

    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    return { accessToken, tokenType: 'Bearer' };
  }
}
