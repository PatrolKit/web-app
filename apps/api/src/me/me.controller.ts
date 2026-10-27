import { CheckinSessionAllowed } from '../common/decorators/checkin-session-allowed.decorator';
import { Body, Controller, Get, HttpCode, Param, Patch, Put, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { MeService } from './me.service';
import { PatchMeDto, SetClockPinDto } from '../contracts/org.contracts';
import type { MeResponse, MyClockResponse } from '../contracts/org.contracts';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly meService: MeService) {}

  @CheckinSessionAllowed()
  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.meService.getMe(user.userId, user.scope ?? 'full');
  }

  @Patch()
  @HttpCode(200)
  patchMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PatchMeDto,
  ): Promise<MeResponse> {
    return this.meService.patchMe(user.userId, body);
  }

  /** How they clock in at each org where they're a member (Plan 57 D7). */
  @Get('clock')
  myClock(@CurrentUser() user: AuthenticatedUser): Promise<MyClockResponse> {
    return this.meService.myClock(user.userId);
  }

  @Put('orgs/:orgId/clock-pin')
  @HttpCode(200)
  setClockPin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orgId') orgId: string,
    @Body() body: SetClockPinDto,
  ): Promise<MyClockResponse> {
    return this.meService.setClockPin(user.userId, orgId, body.pin);
  }
}
