import { Body, Controller, Get, Patch, Put, Param, Req, UseGuards } from '@nestjs/common';
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
import { SkiSwapSettingsService } from './ski-swap-settings.service';
import { UpdateSkiSwapSettingsDto } from '../contracts/ski-swap.contracts';
import { UpdateDevicePinDto } from '../contracts/devices.contracts';

/**
 * `@RequireDeviceRole` sits on the methods rather than the class: the check-in
 * iPad reads settings and the PIN, and nothing here is a device's to write.
 * `PermissionsGuard` refuses a device on any route that does not name a role,
 * so the write routes need no code to say so.
 */
@Controller('orgs/:orgId/ski-swap/settings')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class SkiSwapSettingsController {
  constructor(private readonly settingsService: SkiSwapSettingsService) {}

  @Get()
  @RequireDeviceRole('ski_swap.staff_check_in')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string) {
    return this.settingsService.get(orgId);
  }

  @Patch()
  @RequirePermissions('ski_swap:admin')
  update(
    @Param('orgId') orgId: string,
    @Body() body: UpdateSkiSwapSettingsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.settingsService.upsert(orgId, body, user.userId);
  }

  /**
   * The PIN is a sub-resource rather than a field on the settings response
   * because the two have different readers. Settings is read at `:report` level
   * — `SkiSwapLayout` fetches it for `requireConsignmentScan` on every ski-swap page —
   * and a PIN stored in the clear (Plan 14 D4) has no business travelling to
   * all of them. A separate route puts the rule in a decorator instead of in a
   * response shape that varies by caller.
   */
  @Get('device-pin')
  @RequireDeviceRole('ski_swap.staff_check_in')
  @RequirePermissions('ski_swap:admin')
  getDevicePin(@Param('orgId') orgId: string) {
    return this.settingsService.getDevicePin(orgId);
  }

  @Put('device-pin')
  @RequirePermissions('ski_swap:admin')
  setDevicePin(
    @Param('orgId') orgId: string,
    @Body() body: UpdateDevicePinDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.settingsService.setDevicePin(orgId, body.devicePin, user.userId, req.ip);
  }
}
