import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { PatrollerService } from './patroller.service';
import { TimeEntryService } from './time-entry.service';
import { PatrollerListQueryDto } from '../contracts/time-clock.contracts';
import { TIME_CLOCK_TABLET_ROLES } from '../contracts/devices.contracts';

/**
 * The roster read: the org's members, as the time clock sees them (Plan 57).
 * People are added and edited on Members, so this controller has no writes.
 *
 * A route that names no device role refuses devices: the log is for staff.
 */
@Controller('orgs/:orgId/time-clock/patrollers')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class PatrollerController {
  constructor(
    private readonly patrollerService: PatrollerService,
    private readonly timeEntryService: TimeEntryService,
  ) {}

  @Get()
  @RequireDeviceRole(...TIME_CLOCK_TABLET_ROLES)
  @RequirePermissions('time_tracking:report')
  list(
    @Param('orgId') orgId: string,
    @Query() query: PatrollerListQueryDto,
    @Req() req: Request & { device?: AuthenticatedDevice },
  ) {
    return this.patrollerService.list(orgId, query, { forDevice: !!req.device });
  }

  @Get(':patrollerId/log')
  @RequirePermissions('time_tracking:report')
  log(@Param('orgId') orgId: string, @Param('patrollerId') patrollerId: string) {
    return this.timeEntryService.patrollerLog(orgId, patrollerId);
  }
}
