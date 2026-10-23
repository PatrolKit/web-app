import { Controller, Get, Header, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TimeClockReportService } from './report.service';
import { HoursReportQueryDto } from '../contracts/time-clock.contracts';

@Controller('orgs/:orgId/time-clock/reports')
/** Staff only: a signed-in person, never a device. */
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('time_tracking')
export class TimeClockReportController {
  constructor(private readonly reportService: TimeClockReportService) {}

  @Get('hours')
  @RequirePermissions('time_tracking:report')
  hours(@Param('orgId') orgId: string, @Query() query: HoursReportQueryDto) {
    return this.reportService.hours(orgId, query);
  }

  @Get('hours.csv')
  @RequirePermissions('time_tracking:report')
  @Header('Content-Type', 'text/csv')
  async hoursCsv(@Param('orgId') orgId: string, @Res() res: Response, @Query() query: HoursReportQueryDto) {
    // The file says what it covers: a season, or the dates asked for.
    const day = (iso?: string) => iso?.slice(0, 10);
    const span =
      query.season !== undefined
        ? `season-${query.season}-${query.season + 1}`
        : [day(query.from), day(query.to)].filter(Boolean).join('-to-');
    res.set('Content-Disposition', `attachment; filename="hours${span ? `-${span}` : ''}.csv"`);
    res.send(await this.reportService.hoursCsv(orgId, query));
  }
}
