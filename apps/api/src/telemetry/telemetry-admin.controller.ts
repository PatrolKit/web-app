import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import {
  TelemetryAdminService, type BridgeHistory, type BridgeIdentity, type FleetSummary,
} from './telemetry-admin.service';
import { MAX_INTERVAL_S, MIN_INTERVAL_S } from './telemetry.service';

const SetIntervalSchema = z
  .object({ intervalS: z.number().int().min(MIN_INTERVAL_S).max(MAX_INTERVAL_S).nullable() })
  .strict();
class SetIntervalDto extends createZodDto(SetIntervalSchema) {}

/** Device Telemetry, for Platform Admin. Print bridges only, for now. */
@Controller('admin/telemetry/bridges')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class TelemetryAdminController {
  constructor(private readonly telemetry: TelemetryAdminService) {}

  @Get()
  bridges(): Promise<BridgeIdentity[]> {
    return this.telemetry.bridges();
  }

  @Get('summary')
  fleet(@Query('range') range?: string): Promise<FleetSummary> {
    return this.telemetry.fleet(this.telemetry.parseRange(range));
  }

  @Get(':deviceId')
  history(@Param('deviceId') deviceId: string, @Query('range') range?: string): Promise<BridgeHistory> {
    return this.telemetry.history(deviceId, this.telemetry.parseRange(range));
  }

  @Patch(':deviceId/interval')
  setInterval(@Param('deviceId') deviceId: string, @Body() body: SetIntervalDto): Promise<{ intervalS: number }> {
    return this.telemetry.setInterval(deviceId, body.intervalS);
  }
}
