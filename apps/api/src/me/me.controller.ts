import { Body, Controller, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { MeService } from './me.service';
import { PatchMeDto } from '../contracts/org.contracts';
import type { MeResponse } from '../contracts/org.contracts';

@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeController {
  constructor(private readonly meService: MeService) {}

  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.meService.getMe(user.userId);
  }

  @Patch()
  @HttpCode(200)
  patchMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PatchMeDto,
  ): Promise<MeResponse> {
    return this.meService.patchMe(user.userId, body);
  }
}
