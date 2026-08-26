import { Controller, Get, Header, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { TimeClockReportService } from './report.service';

@Controller('orgs/:orgId/time-clock/reports')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('Time Clock')
@RequireModule('time_tracking')
export class TimeClockReportController {
  constructor(private readonly reportService: TimeClockReportService) {}

  @Get('hours')
  @RequirePermissions('time_tracking:report')
  hours(
    @Param('orgId') orgId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('resortId') resortId?: string,
    @Query('dutyType') dutyType?: string,
  ) {
    return this.reportService.hours(orgId, { from, to, resortId, dutyType });
  }

  @Get('hours.csv')
  @RequirePermissions('time_tracking:report')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="hours.csv"')
  async hoursCsv(
    @Param('orgId') orgId: string,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('resortId') resortId?: string,
    @Query('dutyType') dutyType?: string,
  ) {
    res.send(await this.reportService.hoursCsv(orgId, { from, to, resortId, dutyType }));
  }
}
