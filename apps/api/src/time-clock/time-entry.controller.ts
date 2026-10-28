import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { TimeEntryService } from './time-entry.service';
import { PatchTimeEntryDto, TimeEntryListQueryDto } from '../contracts/time-clock.contracts';
import { TIME_CLOCK_TABLET_ROLES } from '../contracts/devices.contracts';

/**
 * `@RequireDeviceRole` sits on the one route a terminal reads, not on the class:
 * `PermissionsGuard` passes a device on its role alone, so a class-wide role let a
 * terminal correct entries. Routes that name no role refuse devices outright.
 */
@Controller('orgs/:orgId/time-clock/entries')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class TimeEntryController {
  constructor(private readonly timeEntryService: TimeEntryService) {}

  @Get()
  @RequireDeviceRole(...TIME_CLOCK_TABLET_ROLES)
  @RequirePermissions('time_tracking:report')
  list(@Param('orgId') orgId: string, @Query() query: TimeEntryListQueryDto) {
    return this.timeEntryService.list(orgId, query);
  }

  @Get(':entryId/history')
  @RequirePermissions('time_tracking:report')
  history(@Param('orgId') orgId: string, @Param('entryId') entryId: string) {
    return this.timeEntryService.history(orgId, entryId);
  }

  @Patch(':entryId')
  @RequirePermissions('time_tracking:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('entryId') entryId: string,
    @Body() body: PatchTimeEntryDto,
    @Req() req: Request & { user?: AuthenticatedUser },
  ) {
    return this.timeEntryService.patch(orgId, entryId, req.user?.userId, body);
  }
}
