import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { LimitHealthService, type LimitSeries, type LimitsHealth } from './limit-health.service';

/**
 * Server health, for Platform Admin (Plan 26 §11). How close traffic has come
 * to each limit — counts only, never who was counted.
 */
@Controller('admin/health/limits')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class LimitHealthController {
  constructor(private readonly health: LimitHealthService) {}

  @Get()
  summary(@Query('range') range?: string): Promise<LimitsHealth> {
    return this.health.summary(this.health.parseRange(range));
  }

  @Get(':limitId/series')
  series(@Param('limitId') limitId: string, @Query('range') range?: string): Promise<LimitSeries> {
    return this.health.series(limitId, this.health.parseRange(range));
  }
}
