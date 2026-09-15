import {
  Body, Controller, Delete, Get, HttpCode, Param,
  Patch, Post, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { ScannerService } from './scanner.service';
import { CreateScannerDto, PatchScannerDto } from '../contracts/ski-swap.contracts';

/**
 * People only, unlike the printer routes.
 *
 * A printer's list is read by the check-in iPad, which is why that controller
 * takes a device token. Nothing on a device has any reason to enumerate
 * scanners: the bridge is told the one name it needs, on its claim.
 */
@Controller('orgs/:orgId/ski-swap/scanners')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class ScannerController {
  constructor(private readonly scannerService: ScannerService) {}

  @Get()
  @RequirePermissions('ski_swap:manage')
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
