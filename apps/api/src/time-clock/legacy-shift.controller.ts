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
 * Time entries under their old name, for iPads in the field (Plan 58 D3). Same
 * routes, guards and answers as before the rename: a walk's page names its rows
 * `shifts`. Retired once Health shows every terminal on a build that reads
 * `time-clock/entries`.
 */
@Controller('orgs/:orgId/time-clock/shifts')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class LegacyShiftController {
  constructor(private readonly timeEntryService: TimeEntryService) {}

  @Get()
  @RequireDeviceRole(...TIME_CLOCK_TABLET_ROLES)
  @RequirePermissions('time_tracking:report')
  async list(@Param('orgId') orgId: string, @Query() query: TimeEntryListQueryDto) {
    const result = await this.timeEntryService.list(orgId, query);
    if (Array.isArray(result)) return result;
    const { entries, ...rest } = result;
    return { shifts: entries, ...rest };
  }

  @Get(':shiftId/history')
  @RequirePermissions('time_tracking:report')
  history(@Param('orgId') orgId: string, @Param('shiftId') shiftId: string) {
    return this.timeEntryService.history(orgId, shiftId);
  }

  @Patch(':shiftId')
  @RequirePermissions('time_tracking:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('shiftId') shiftId: string,
    @Body() body: PatchTimeEntryDto,
    @Req() req: Request & { user?: AuthenticatedUser },
  ) {
    return this.timeEntryService.patch(orgId, shiftId, req.user?.userId, body);
  }
}
