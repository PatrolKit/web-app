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
import { PrinterService } from './printer.service';
import { CreatePrinterDto, PatchPrinterDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/printers')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class PrinterController {
  constructor(private readonly printerService: PrinterService) {}

  @Get()
  @RequirePermissions('ski_swap:manage')
  list(@Param('orgId') orgId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.printerService.list(orgId, user.userId);
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
}
