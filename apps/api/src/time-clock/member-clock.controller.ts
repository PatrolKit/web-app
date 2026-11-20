import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard, type OrgMembership } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { MemberClockService } from './member-clock.service';
import { MemberClockEventDto, MyEntriesQueryDto } from '../contracts/time-clock.contracts';

type MemberRequest = Request & { membership: OrgMembership };

/** A patroller's own clock, on a phone or the website (Plan 59 §5). */
@Controller('me/orgs/:orgId/time-clock')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard)
@RequireModule('time_tracking')
export class MemberClockController {
  constructor(private readonly service: MemberClockService) {}

  @Get('shift')
  shift(@Param('orgId') orgId: string, @Req() req: MemberRequest) {
    return this.service.shift(orgId, req.membership.id);
  }

  @Post('events')
  @HttpCode(200)
  submit(@Param('orgId') orgId: string, @Req() req: MemberRequest, @Body() body: MemberClockEventDto) {
    return this.service.submit(orgId, req.membership.id, body);
  }

  @Get('entries')
  entries(@Param('orgId') orgId: string, @Req() req: MemberRequest, @Query() q: MyEntriesQueryDto) {
    return this.service.entries(orgId, req.membership.id, q.take);
  }
}
