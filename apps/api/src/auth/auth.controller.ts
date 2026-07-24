import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { MagicLinkRequestDto, MagicLinkVerifyDto, DeviceTokenRequestDto } from '../contracts/auth.contracts';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { DeviceTokenResponse } from '../contracts/devices.contracts';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Magic link ─────────────────────────────────────────────────────────────

  @Post('magic-link')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestMagicLink(@Body() body: MagicLinkRequestDto): Promise<{ queued: true }> {
    await this.authService.requestMagicLink(body.email);
    return { queued: true };
  }

  @Post('magic-link/verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async verifyMagicLink(
    @Body() body: MagicLinkVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    return this.authService.verifyMagicLink(body.token, res, {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });
  }

  // ─── Refresh & logout ────────────────────────────────────────────────────────

  @Post('refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    return this.authService.refresh(req, res, { ipAddress: req.ip });
  }

  @Post('logout')
  @HttpCode(200)
  @SkipThrottle()
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.authService.logout(req, res);
  }

  // ─── Device token ────────────────────────────────────────────────────────────

  @Post('device/token')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  deviceToken(@Body() body: DeviceTokenRequestDto): Promise<DeviceTokenResponse> {
    return this.authService.getDeviceToken(body.clientId, body.clientSecret);
  }
}
