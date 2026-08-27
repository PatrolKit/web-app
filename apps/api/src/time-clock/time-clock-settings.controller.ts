import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TimeClockSettingsService } from './time-clock-settings.service';
import { UpdateTimeClockSettingsDto } from '../contracts/time-clock.contracts';

@Controller('orgs/:orgId/time-clock/settings')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('time_clock.terminal')
@RequireModule('time_tracking')
export class TimeClockSettingsController {
  constructor(private readonly settingsService: TimeClockSettingsService) {}

  @Get()
  @RequirePermissions('time_tracking:report')
  get(@Param('orgId') orgId: string) {
    return this.settingsService.get(orgId);
  }

  @Patch()
  @RequirePermissions('time_tracking:admin')
  update(@Param('orgId') orgId: string, @Body() body: UpdateTimeClockSettingsDto) {
    return this.settingsService.update(orgId, body);
  }
}
