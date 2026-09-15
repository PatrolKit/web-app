import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { ScanService } from './scan.service';
import { SubmitScanDto } from '../contracts/ski-swap.contracts';

/**
 * Tags read by a bridge's barcode scanner.
 *
 * Its own endpoint rather than a field on the claim. Carrying scans on the claim
 * would have saved a TLS handshake back when the firmware opened a fresh
 * connection per request; it now reuses one, and a round trip is about 125 ms —
 * quick enough for feedback to reach the operator while they are still holding
 * the item, which was the only thing the coupling would have bought.
 *
 * Throttling is skipped for the same reason the claim skips it: a volunteer
 * working through a pile scans as fast as they can pick things up, and a rate
 * limit would read to them as the scanner being broken.
 */
@Controller('devices/me/scans')
@UseGuards(DeviceAuthGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.print_bridge')
@SkipThrottle()
export class ScanController {
  constructor(private readonly scans: ScanService) {}

  /**
   * 200 accepted, 404 unknown tag, 409 ambiguous.
   *
   * Every refusal is a 4xx on purpose: the firmware dequeues those and counts
   * them, because retrying cannot help. Anything it should retry has to be a
   * 5xx, which is what an unhandled fault already is.
   *
   * The firmware reads the status and not the body. The body is here for a
   * person reading a log, and for whatever shows a rejection reason later.
   */
  @Post()
  @HttpCode(200)
  submit(@CurrentDevice() device: AuthenticatedDevice, @Body() body: SubmitScanDto) {
    return this.scans.submit(device.orgId, device.deviceId, body.sku);
  }
}
