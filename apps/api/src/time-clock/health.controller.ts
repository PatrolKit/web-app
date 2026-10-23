import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TimeClockHealthService } from './health.service';

/** What went wrong, and which terminals have gone quiet (Plan 55 D13). Staff only. */
@Controller('orgs/:orgId/time-clock/health')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class TimeClockHealthController {
  constructor(private readonly healthService: TimeClockHealthService) {}

  @Get()
  @RequirePermissions('time_tracking:manage')
  get(@Param('orgId') orgId: string) {
    return this.healthService.get(orgId);
  }
}
