import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from './jwt.service';
import { MailService } from '../mail/mail.service';
import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'crypto';
import type { Request, Response } from 'express';
import type { DeviceTokenResponse } from '../contracts/devices.contracts';

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
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  // ─── Magic link ─────────────────────────────────────────────────────────────

  async requestMagicLink(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'active') {
      // Uniform 200 — no account enumeration
      return;
    }    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const ttl = this.config.get<number>('app.magicLinkTtl', 900);
    const expiresAt = new Date(Date.now() + ttl * 1000);

    await this.prisma.magicLink.create({
      data: { id: createId(), userId: user.id, tokenHash, expiresAt },
    });

    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    const magicLinkUrl = `${appUrl}/app/auth/verify?token=${rawToken}`;

    // Fire-and-forget — never throw back to caller
    this.mailService.sendMagicLink(user.email, magicLinkUrl).catch((err) => {
      this.logger.error({ err }, 'Magic-link email delivery failed');
    });
  }

  /** Creates a 30-day magic-link token for a seller invitation. Returns the full verify URL. */
  async createInviteMagicLink(userId: string): Promise<string> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await this.prisma.magicLink.create({
      data: { id: createId(), userId, tokenHash, expiresAt },
    });
    const appUrl = this.config.get<string>('app.appUrl', 'http://localhost:3000');
    return `${appUrl}/app/auth/verify?token=${rawToken}`;
  }

  async verifyMagicLink(
    rawToken: string,
    res: Response,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<{ accessToken: string }> {
    const tokenHash = sha256(rawToken);
    const link = await this.prisma.magicLink.findUnique({ where: { tokenHash } });

    if (!link || link.usedAt || link.expiresAt < new Date()) {
      throw new UnauthorizedException('Invalid or expired magic link');
    }

    // Mark used atomically
    await this.prisma.magicLink.update({
      where: { id: link.id },
      data: { usedAt: new Date() },
    });

    const accessToken = await this.jwtService.signAccessToken(link.userId);
    await this.issueRefreshCookie(link.userId, res, meta);

    return { accessToken };
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

    // Revoke old token
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
