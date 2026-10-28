import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { TimeClockFoldService } from './fold.service';
import { PatrollerService } from './patroller.service';
import { PatrollerController } from './patroller.controller';
import { TimeClockSettingsService } from './time-clock-settings.service';
import { TimeClockSettingsController } from './time-clock-settings.controller';
import { TimeClockEventService } from './event.service';
import { TimeClockEventController } from './event.controller';
import { TimeEntryService } from './time-entry.service';
import { TimeEntryController } from './time-entry.controller';
import { LegacyShiftController } from './legacy-shift.controller';
import { TimeClockReportService } from './report.service';
import { TimeClockReportController } from './report.controller';
import { ClockOutService } from './clock-out.service';
import { SeasonService } from './season.service';
import { SeasonController } from './season.controller';
import { TimeClockHealthService } from './health.service';
import { TimeClockHealthController } from './health.controller';

@Module({
  imports: [AuthModule, PermissionsModule],
  controllers: [
    PatrollerController,
    TimeClockSettingsController,
    TimeClockEventController,
    TimeEntryController,
    LegacyShiftController,
    TimeClockReportController,
    SeasonController,
    TimeClockHealthController,
  ],
  providers: [
    TimeClockFoldService,
    PatrollerService,
    TimeClockSettingsService,
    TimeClockEventService,
    TimeEntryService,
    TimeClockReportService,
    SeasonService,
    TimeClockHealthService,
    ClockOutService,
  ],
  exports: [ClockOutService],
})
export class TimeClockModule {}
