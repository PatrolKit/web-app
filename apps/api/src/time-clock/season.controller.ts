import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { SeasonService } from './season.service';

/**
 * The seasons the pickers offer (Plan 55 D12). The cutover itself is an org setting,
 * written under Org Admin; this only reads it. Staff only: the iPad never sees seasons.
 */
@Controller('orgs/:orgId/time-clock/seasons')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class SeasonController {
  constructor(private readonly seasonService: SeasonService) {}

  @Get()
  @RequirePermissions('time_tracking:report')
  list(@Param('orgId') orgId: string) {
    return this.seasonService.list(orgId);
  }
}
