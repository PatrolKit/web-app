import { Global, Module } from '@nestjs/common';
import { TelemetryController } from './telemetry.controller';
import { TelemetryAdminController } from './telemetry-admin.controller';
import { TelemetryService } from './telemetry.service';
import { TelemetryAdminService } from './telemetry-admin.service';

/** Device telemetry: reports from bridges, outages from their check-ins. */
@Global()
@Module({
  controllers: [TelemetryController, TelemetryAdminController],
  providers: [TelemetryService, TelemetryAdminService],
  exports: [TelemetryService],
})
export class TelemetryModule {}
