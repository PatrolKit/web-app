import { Body, Controller, Get, Put, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { SkiSwapSettingsService } from './ski-swap-settings.service';
import { UpdateSkiSwapSettingsDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/settings')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class SkiSwapSettingsController {
  constructor(private readonly settingsService: SkiSwapSettingsService) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string) {
    return this.settingsService.get(orgId);
  }

  @Put()
  @RequirePermissions('ski_swap:admin')
  upsert(@Param('orgId') orgId: string, @Body() body: UpdateSkiSwapSettingsDto) {
    return this.settingsService.upsert(orgId, body.labelsPerItem);
  }
}
