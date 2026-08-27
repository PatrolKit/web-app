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
import { PatchShiftDto } from '../contracts/time-clock.contracts';

@Controller('orgs/:orgId/time-clock/shifts')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('time_clock.terminal')
@RequireModule('time_tracking')
export class ShiftController {
  constructor(private readonly shiftService: ShiftService) {}

  @Get()
  @RequirePermissions('time_tracking:report')
  list(
    @Param('orgId') orgId: string,
    @Query('resortId') resortId?: string,
    @Query('status') status?: string,
    @Query('updatedSince') updatedSince?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('dutyType') dutyType?: string,
    @Query('pastSweep') pastSweep?: string,
  ) {
    return this.shiftService.list(orgId, {
      resortId,
      status,
      updatedSince,
      from,
      to,
      dutyType,
      pastSweep: pastSweep === 'true',
    });
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
