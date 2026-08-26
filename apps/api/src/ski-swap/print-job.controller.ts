import { Body, Controller, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { PrintQueueService } from './print-queue.service';
import { NackJobDto } from '../contracts/ski-swap.contracts';

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
@RequireDeviceRole('Ski Swap - Network Printer Adapter')
@SkipThrottle()
export class PrintJobController {
  constructor(private readonly queue: PrintQueueService) {}

  @Post('claim')
  @HttpCode(200)
  claim(@CurrentDevice() device: AuthenticatedDevice, @Query('limit') limit?: string) {
    const n = Math.min(Math.max(Number(limit) || 4, 1), 16);
    return this.queue.claim(device.deviceId, n);
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
