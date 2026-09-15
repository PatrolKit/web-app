import {
  Body, Controller, Delete, Get, HttpCode, Param,
  Patch, Post, UseGuards,
} from '@nestjs/common';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { ScannerService } from './scanner.service';
import { CreateScannerDto, PatchScannerDto } from '../contracts/ski-swap.contracts';

/**
 * Reading is open to the check-in iPad. Writing is not.
 *
 * `@RequireDeviceRole` is on the list handler rather than on the class, and that
 * placement is the whole of the access rule. `PermissionsGuard` checks a device
 * against its role *instead of* against permission keys — a device that clears
 * the role is through, and the `ski_swap:admin` on create, patch and delete is
 * never consulted for it. So a class-level role decorator would hand a check-in
 * iPad the ability to delete scanners, which nobody asked for. On the handler,
 * every other route sees no roles at all and turns devices away.
 */
@Controller('orgs/:orgId/ski-swap/scanners')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class ScannerController {
  constructor(private readonly scannerService: ScannerService) {}

  /**
   * The org's scanners, for the iPad's picker and the Hardware page alike.
   *
   * Unpaginated, a bare array, exactly as the printer list is. There is no
   * `limit`, no `offset` and no `total`: an org owns a handful of these.
   */
  @Get()
  @RequirePermissions('ski_swap:manage')
  @RequireDeviceRole('ski_swap.staff_check_in')
  list(@Param('orgId') orgId: string) {
    return this.scannerService.list(orgId);
  }

  @Post()
  @RequirePermissions('ski_swap:admin')
  create(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateScannerDto,
  ) {
    return this.scannerService.create(orgId, user.userId, body);
  }

  @Patch(':scannerId')
  @RequirePermissions('ski_swap:admin')
  patch(
    @Param('orgId') orgId: string,
    @Param('scannerId') scannerId: string,
    @Body() body: PatchScannerDto,
  ) {
    return this.scannerService.patch(orgId, scannerId, body);
  }

  @Delete(':scannerId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:admin')
  async remove(@Param('orgId') orgId: string, @Param('scannerId') scannerId: string) {
    await this.scannerService.remove(orgId, scannerId);
  }
}
