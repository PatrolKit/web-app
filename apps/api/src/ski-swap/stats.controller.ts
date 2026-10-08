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

  /** Item check-ins by day and hour, with their sellers, for the heat map. Our rows only. */
  @Get('checkins')
  @RequirePermissions('ski_swap:report')
  checkins(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.statsService.getCheckinsHeatmap(orgId, swapId);
  }

  /** Items per category, busiest first, without "Other". Our rows only. */
  @Get('categories')
  @RequirePermissions('ski_swap:report')
  categories(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.statsService.getCategoryCounts(orgId, swapId);
  }

  /** Sold, for sale, needs a price or description, not on sale yet: reads Square's sales. */
  @Get('breakdown')
  @RequirePermissions('ski_swap:report')
  breakdownOf(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.breakdown.get(orgId, swapId);
  }

  /** Sales by hour (Plan 46): units and dollars, from the same Square read as the breakdown. */
  @Get('sales-heatmap')
  @RequirePermissions('ski_swap:report')
  salesHeatmap(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.breakdown.salesHeatmap(orgId, swapId);
  }

  /** Units sold per category (Plan 46), from the same Square read as the breakdown. */
  @Get('sold-by-category')
  @RequirePermissions('ski_swap:report')
  soldByCategory(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.breakdown.soldByCategory(orgId, swapId);
  }

  /** Each seller's items, listed and sold dollars, with no names: the seller histogram. */
  @Get('seller-totals')
  @RequirePermissions('ski_swap:report')
  sellerTotals(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.breakdown.sellerTotals(orgId, swapId);
  }

  /** Each Square checkout's items and dollars: the buyer histogram. */
  @Get('checkout-totals')
  @RequirePermissions('ski_swap:report')
  checkoutTotals(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.breakdown.checkoutTotals(orgId, swapId);
  }
}
