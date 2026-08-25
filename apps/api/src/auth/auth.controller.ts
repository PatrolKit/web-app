import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginRequestDto, ChallengeConfirmDto, DeviceTokenRequestDto } from '../contracts/auth.contracts';
import type { AuthTokenResponse, LoginResponse } from '../contracts/auth.contracts';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { DeviceTokenResponse } from '../contracts/devices.contracts';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ─── Login (email magic link or phone OTP) ──────────────────────────────────

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async login(@Body() body: LoginRequestDto): Promise<LoginResponse> {
    const issued = await this.authService.requestLogin(body);
    // Identical shape whether or not the account exists: an absent person still
    // gets a (decoy) challenge id, so this response is not an enumeration oracle.
    return {
      queued: true,
      challengeId: issued?.challengeId ?? null,
      channel: issued?.channel ?? null,
      ...(issued?.devCode ? { devCode: issued.devCode } : {}),
    };
  }

  @Post('challenges/:id/confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async confirmChallenge(
    @Param('id') challengeId: string,
    @Body() body: ChallengeConfirmDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthTokenResponse> {
    return this.authService.confirmChallenge(challengeId, body.code, res, {
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
