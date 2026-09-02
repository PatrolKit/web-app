import { Body, Controller, Get, Param, Patch, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { TimeClockSettingsService } from './time-clock-settings.service';
import { UpdateTimeClockSettingsDto } from '../contracts/time-clock.contracts';
import { UpdateDevicePinDto } from '../contracts/devices.contracts';

/**
 * `@RequireDeviceRole` sits on the methods rather than the class: a terminal
 * reads the auto-close policy and the PIN, and writes neither. `PermissionsGuard`
 * refuses a device on any route that does not name a role, so the write routes
 * need no code to say so.
 */
@Controller('orgs/:orgId/time-clock/settings')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class TimeClockSettingsController {
  constructor(private readonly settingsService: TimeClockSettingsService) {}

  @Get()
  @RequireDeviceRole('time_clock.terminal')
  @RequirePermissions('time_tracking:report')
  get(@Param('orgId') orgId: string) {
    return this.settingsService.get(orgId);
  }

  @Patch()
  @RequirePermissions('time_tracking:admin')
  update(@Param('orgId') orgId: string, @Body() body: UpdateTimeClockSettingsDto) {
    return this.settingsService.update(orgId, body);
  }

  /**
   * A sub-resource rather than a field on the settings response, because the
   * two have different readers: the policy above is read at `:report` level,
   * and a PIN stored in the clear (Plan 14 D4) should not travel with it.
   */
  @Get('device-pin')
  @RequireDeviceRole('time_clock.terminal')
  @RequirePermissions('time_tracking:admin')
  getDevicePin(@Param('orgId') orgId: string) {
    return this.settingsService.getDevicePin(orgId);
  }

  @Put('device-pin')
  @RequirePermissions('time_tracking:admin')
  setDevicePin(
    @Param('orgId') orgId: string,
    @Body() body: UpdateDevicePinDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.settingsService.setDevicePin(orgId, body.devicePin, user.userId, req.ip);
  }
}
