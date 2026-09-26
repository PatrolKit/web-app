import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { TelemetryService } from './telemetry.service';

/**
 * Where a bridge sends a snapshot of its health (webprinter_esp32 Plan 4): once
 * after its first login following a boot, then every `intervalS`.
 *
 * The body is deliberately untyped. There is no schema here to refuse a field
 * the server has not heard of yet — see `telemetry-report.ts`.
 *
 * Not throttled, like the claim. A bridge in a crash loop reports once per
 * boot, and that burst is the signal, not something to rate-limit away.
 */
@Controller('devices/me/telemetry')
@UseGuards(DeviceAuthGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.print_bridge')
@SkipThrottle()
export class TelemetryController {
  constructor(private readonly telemetry: TelemetryService) {}

  @Post()
  @HttpCode(200)
  report(
    @CurrentDevice() device: AuthenticatedDevice,
    @Body() body: unknown,
    @Headers('content-length') contentLength?: string,
  ): Promise<{ intervalS: number }> {
    const length = contentLength === undefined ? undefined : Number(contentLength);
    return this.telemetry.ingest(device.deviceId, body, Number.isFinite(length) ? length : undefined);
  }
}
