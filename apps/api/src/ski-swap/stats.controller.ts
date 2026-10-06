import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { StatsService } from './stats.service';
import { ItemBreakdownService } from './item-breakdown.service';

@Controller('orgs/:orgId/ski-swap/swaps/:swapId/stats')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class StatsController {
  constructor(
    private readonly statsService: StatsService,
    private readonly breakdown: ItemBreakdownService,
  ) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.statsService.getSwapStats(orgId, swapId);
  }

  /** Sold, for sale, needs a price or description, not on sale yet: reads Square's sales. */
  @Get('breakdown')
  @RequirePermissions('ski_swap:report')
  breakdownOf(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.breakdown.get(orgId, swapId);
  }
}
