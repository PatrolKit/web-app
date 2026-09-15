import { Body, Controller, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { PrintQueueService } from './print-queue.service';
import { ClaimJobsDto, NackJobDto } from '../contracts/ski-swap.contracts';

/**
 * The contract an ESP-32 bridge implements.
 *
 * Every route is scoped to the station the calling device is bound to, so a
 * bridge can only ever drain its own queue. Throttling is skipped because the
 * claim is designed to be polled once a second — the seller is stood at the
 * printer waiting for a tag, so pickup latency *is* the poll interval.
 */
@Controller('devices/me/print-jobs')
@UseGuards(DeviceAuthGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.print_bridge')
@SkipThrottle()
export class PrintJobController {
  constructor(private readonly queue: PrintQueueService) {}

  @Post('claim')
  @HttpCode(200)
  claim(
    @CurrentDevice() device: AuthenticatedDevice,
    @Body() body: ClaimJobsDto,
    @Query('limit') limit?: string,
    @Query('wait') wait?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    // `limit=0` is a heartbeat: a bridge with a downed printer has nowhere to
    // put a job but still needs to say it is alive, or staff cannot tell a dead
    // printer from a dead bridge.
    const requested = limit === undefined ? 4 : Number(limit);
    const n = Number.isFinite(requested) ? Math.min(Math.max(requested, 0), 16) : 4;
    // The response travels down so an empty claim can be held open until work
    // arrives, and abandoned the moment the bridge disconnects.
    // `wait` is how long the caller will let the server hold an empty claim.
    // Omitted means the default hold, which is what the firmware wants; zero is
    // for anything that needs an answer rather than a tag.
    const held = wait === undefined ? undefined : Number(wait);
    return this.queue.claim(
      device.deviceId,
      n,
      body?.printerLink,
      {
        link: body?.scannerLink,
        battery: body?.scannerBattery,
        queueDepth: body?.scanQueueDepth,
      },
      res,
      Number.isFinite(held) ? held : undefined,
    );
  }

  @Post(':jobId/ack')
  @HttpCode(204)
  async ack(@CurrentDevice() device: AuthenticatedDevice, @Param('jobId') jobId: string) {
    await this.queue.ack(device.deviceId, jobId);
  }

  @Post(':jobId/nack')
  @HttpCode(204)
  async nack(
    @CurrentDevice() device: AuthenticatedDevice,
    @Param('jobId') jobId: string,
    @Body() body: NackJobDto,
  ) {
    await this.queue.nack(device.deviceId, jobId, body.error);
  }
}
