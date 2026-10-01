import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Limit } from '../common/limits/limit.decorator';
import { PlatformSettingsService } from './platform-settings.service';
import { PatchPlatformSettingsDto } from '../contracts/platform-settings.contracts';
import type { PlatformSettingsResponse, PublicFeaturesResponse } from '../contracts/platform-settings.contracts';

/** Platform Admin → Configuration (Plan 29). */
@Controller('admin/settings')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  get(): Promise<PlatformSettingsResponse> {
    return this.settings.describe();
  }

  @Patch()
  async patch(
    @Body() body: PatchPlatformSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PlatformSettingsResponse> {
    await this.settings.update(body, user.userId);
    return this.settings.describe();
  }
}

/**
 * What the signed-out pages need to decide what to offer: sign-in and self
 * check-in run before anyone has a token.
 */
@Controller('public/features')
@Limit('public.reads')
export class PublicFeaturesController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  async get(): Promise<PublicFeaturesResponse> {
    return { sms: await this.settings.smsEnabled() };
  }
}
