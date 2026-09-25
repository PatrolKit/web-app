import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Response } from 'express';
import { SkipThrottle } from '@nestjs/throttler';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { PrintQueueService } from './print-queue.service';
import { ClaimJobsDto, NackJobDto } from '../contracts/ski-swap.contracts';
import { parseByteRange } from '../common/util/byte-range';

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
    // `omit` leaves the base64 out and sends `rasterBytes` in its place; the
    // bytes then come from `GET :jobId/raster`. Anything else, or nothing, is
    // the inline claim every deployed bridge already speaks.
    @Query('payload') payload?: string,
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
      { omitPayload: payload === 'omit' },
    );
  }

  /**
   * A claimed job's raster as raw bytes, for a bridge with no room to hold it
   * as base64 inside JSON.
   *
   * Written straight to the socket rather than returned, so it bypasses the
   * `{ success, data }` envelope. `Content-Length` is exact and set up front:
   * the bridge allocates that many bytes before reading. Nothing on the path
   * may compress it — inflating needs a window the bridge does not have — so
   * the response says `no-transform`, and Caddy here has no `encode`.
   *
   * **Ranges**, because a TLS record can be no larger than what is being sent.
   * A bridge that decrypts a whole record at a time cannot hold a 16 KB one
   * beside its raster buffer, and asking for 4 KB pieces caps every record at
   * that, whatever the connection's history. One range per request; anything
   * the parser does not take is answered with the whole raster.
   *
   * **`ETag`** is a digest of the bytes, the same on every response in a claim.
   * The bytes are the claim's own render, kept for the lease — except after a
   * restart, when the job is rendered again, and a label whose item or printer
   * changed meanwhile would come out different. A bridge assembling pieces
   * compares the tags and nacks on a mismatch rather than print half of each.
   */
  @Get(':jobId/raster')
  async raster(
    @CurrentDevice() device: AuthenticatedDevice,
    @Param('jobId') jobId: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ) {
    const bytes = await this.queue.raster(device.deviceId, jobId);
    const range = parseByteRange(rangeHeader, bytes.length);
    res.set({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store, no-transform',
      ETag: `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 27)}"`,
    });

    if (range.kind === 'unsatisfiable') {
      res.status(416).set({
        'Content-Range': `bytes */${bytes.length}`,
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ success: false, error: 'Range not satisfiable' }));
      return;
    }

    const body = range.kind === 'part' ? bytes.subarray(range.start, range.end + 1) : bytes;
    res.status(range.kind === 'part' ? 206 : 200).set({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.length),
      ...(range.kind === 'part'
        ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.length}` }
        : {}),
    });
    res.end(body);
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
