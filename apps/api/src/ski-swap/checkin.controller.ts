import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Limit } from '../common/limits/limit.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { CheckinService } from './checkin.service';
import { CheckinContextDto, CheckinRegisterDto } from '../contracts/ski-swap.contracts';

/**
 * The unauthenticated half of check-in: what a station QR resolves to, and how
 * someone who has never sold here gets a code.
 *
 * Limited per IP, and sized for a venue: at a swap every phone in the building
 * shares one address. What `register` sends is limited per destination instead,
 * in `ContactChallengeService.issue`, which is where the real protection is.
 */
@Controller('public/checkin/:swapId')
@Limit('checkin.page')
export class PublicCheckinController {
  constructor(private readonly checkin: CheckinService) {}

  @Get()
  context(@Param('swapId') swapId: string, @Query('station') stationId: string) {
    return this.checkin.context(swapId, stationId);
  }

  @Post('register')
  @HttpCode(200)
  @Limit('checkin.register')
  async register(
    @Param('swapId') swapId: string,
    @Query('station') stationId: string,
    @Body() body: CheckinRegisterDto,
  ) {
    const issued = await this.checkin.register(swapId, stationId, body);
    return {
      queued: true,
      challengeId: issued.challengeId,
      channel: issued.channel,
      ...(issued.devCode ? { devCode: issued.devCode } : {}),
    };
  }
}

/**
 * The authenticated half.
 *
 * Notably *not* behind `OrgContextGuard` or `SellerProfileGuard`: `join` is what
 * creates the membership and the seller profile, so requiring either would make
 * check-in impossible for exactly the people it exists for. The station QR is
 * the credential — it is physically at the venue — and both ids are validated
 * against a running swap on every call.
 */
@Controller('orgs/:orgId/ski-swap/checkin')
@UseGuards(JwtAuthGuard, ModuleEnabledGuard)
@RequireModule('ski_swap')
export class CheckinController {
  constructor(private readonly checkin: CheckinService) {}

  @Post('join')
  @HttpCode(200)
  join(@CurrentUser() user: AuthenticatedUser, @Body() body: CheckinContextDto) {
    return this.checkin.join(user.userId, body.swapId, body.stationId);
  }

  @Get('summary')
  summary(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('swapId') swapId: string,
  ) {
    return this.checkin.summary(orgId, user.userId, swapId);
  }

  @Post('finish')
  @HttpCode(200)
  finish(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CheckinContextDto,
  ) {
    return this.checkin.finish(orgId, user.userId, body.swapId, body.stationId);
  }
}
