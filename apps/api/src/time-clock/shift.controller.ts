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
import { ShiftService } from './shift.service';
import { PatchShiftDto, ShiftListQueryDto } from '../contracts/time-clock.contracts';

/**
 * `@RequireDeviceRole` sits on the one route a terminal reads, not on the class:
 * `PermissionsGuard` passes a device on its role alone, so a class-wide role let a
 * terminal correct shifts. Routes that name no role refuse devices outright.
 */
@Controller('orgs/:orgId/time-clock/shifts')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class ShiftController {
  constructor(private readonly shiftService: ShiftService) {}

  @Get()
  @RequireDeviceRole('time_clock.terminal')
  @RequirePermissions('time_tracking:report')
  list(@Param('orgId') orgId: string, @Query() query: ShiftListQueryDto) {
    return this.shiftService.list(orgId, query);
  }

  @Get(':shiftId/history')
  @RequirePermissions('time_tracking:report')
  history(@Param('orgId') orgId: string, @Param('shiftId') shiftId: string) {
    return this.shiftService.history(orgId, shiftId);
  }

  @Patch(':shiftId')
  @RequirePermissions('time_tracking:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('shiftId') shiftId: string,
    @Body() body: PatchShiftDto,
    @Req() req: Request & { user?: AuthenticatedUser },
  ) {
    return this.shiftService.patch(orgId, shiftId, req.user?.userId, body);
  }
}
