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
import { PrinterService } from './printer.service';
import { LabelRenderService } from './printing/label-render.service';
import {
  CreatePrinterDto,
  PatchPrinterDto,
  PatchPrinterPaperSizeDto,
  RenderLabelDto,
} from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/printers')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
@RequireModule('ski_swap')
export class PrinterController {
  constructor(
    private readonly printerService: PrinterService,
    private readonly labels: LabelRenderService,
  ) {}

  @Get()
  @RequirePermissions('ski_swap:manage')
  list(@Param('orgId') orgId: string, @CurrentUser() user?: AuthenticatedUser) {
    return this.printerService.list(orgId, user?.userId);
  }

  @Post()
  @RequirePermissions('ski_swap:admin')
  create(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreatePrinterDto,
  ) {
    return this.printerService.create(orgId, user.userId, body);
  }

  @Patch(':printerId')
  @RequirePermissions('ski_swap:admin')
  patch(
    @Param('orgId') orgId: string,
    @Param('printerId') printerId: string,
    @Body() body: PatchPrinterDto,
  ) {
    return this.printerService.patch(orgId, printerId, body);
  }

  @Delete(':printerId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:admin')
  async remove(@Param('orgId') orgId: string, @Param('printerId') printerId: string) {
    await this.printerService.remove(orgId, printerId);
  }

  @Patch(':printerId/paper-size')
  // Permission check is in the service — accepts ski_swap:manage or business_seller
  patchPaperSize(
    @Param('orgId') orgId: string,
    @Param('printerId') printerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PatchPrinterPaperSizeDto,
  ) {
    return this.printerService.patchPaperSize(orgId, printerId, body.paperSize, user.userId);
  }

  /**
   * Renders a label for a browser to write over Web Bluetooth.
   *
   * The browser used to lay these out itself, which is how the two renderers
   * drifted on head width and produced tags that would not scan. It now asks
   * for finished bytes against this printer's own paper size and margins — the
   * same call the ESP-32 bridge makes, so there is one layout to be wrong about.
   */
  @Post(':printerId/labels')
  @HttpCode(200)
  // Access is checked in the service: staff drive org-pool printers, a business
  // seller drives only the printer assigned to them.
  renderLabel(
    @Param('orgId') orgId: string,
    @Param('printerId') printerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: RenderLabelDto,
  ) {
    return this.labels.render(orgId, printerId, user.userId, body);
  }
}
