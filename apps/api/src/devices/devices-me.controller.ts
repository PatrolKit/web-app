import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Patch, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { DevicesService } from './devices.service';
import { BootstrapService } from '../bootstrap/bootstrap.service';
import { RebindDeviceDto } from '../contracts/devices.contracts';
import type { DeviceMeResponse } from '../contracts/devices.contracts';

@Controller('devices')
@UseGuards(DeviceAuthGuard)
export class DevicesMeController {
  constructor(
    private readonly devicesService: DevicesService,
    private readonly bootstrap: BootstrapService,
  ) {}

  @Get('me')
  getMe(@CurrentDevice() device: AuthenticatedDevice): Promise<DeviceMeResponse> {
    return this.devicesService.getDeviceMe(device.deviceId);
  }

  /**
   * A terminal that has been carried to another lodge, saying so.
   *
   * The role is checked here rather than by a guard because this is the only
   * route on the controller that is not open to every device: reading your own
   * record is universal, changing where you stand is not.
   *
   * A signage display also has a resort and is still refused. Rebinding exists
   * because the moment it is wanted is the moment a computer is least available
   * — someone is holding the iPad, in the building it just moved to. Nobody
   * carries a screen that is bolted to a wall, and a display has no input
   * device to ask with.
   */
  @Patch('me/resort')
  @HttpCode(200)
  rebind(
    @CurrentDevice() device: AuthenticatedDevice,
    @Body() body: RebindDeviceDto,
  ): Promise<DeviceMeResponse> {
    if (device.role !== 'time_clock.terminal') {
      throw new ForbiddenException('Only a time clock terminal has a resort to change');
    }
    return this.devicesService.rebindSelf(device.deviceId, body.resortId);
  }

  /**
   * What software this device should be running (device image plan §6.1).
   *
   * The endpoint that makes one image become a signage device without being
   * rebuilt. It is the *only* route in this API that writes its own response:
   *
   *   - a `304` must carry no body, and the global `ResponseInterceptor` would
   *     wrap one in `{success, data}` — a protocol error the device would read
   *     as a malformed manifest;
   *   - the ETag is ours, computed over the resolved manifest, and must not be
   *     the one Express would derive from the bytes it happens to send.
   *
   * `@Res()` without `passthrough` is what buys both. A `200` still carries the
   * house envelope, which the device's client unwraps.
   */
  @Get('me/bootstrap')
  async getBootstrap(
    @CurrentDevice() device: AuthenticatedDevice,
    @Headers('x-patrolkit-hardware-id') hardwareId: string | undefined,
    @Headers('x-patrolkit-image') image: string | undefined,
    @Headers('x-patrolkit-packages') packages: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    // Recorded before the manifest is resolved, and regardless of how that
    // goes. A device calling in against a role nobody has configured is the
    // exact case where knowing it called in is worth most.
    const [imageName, imageVersion] = splitImageHeader(image);
    await this.bootstrap.recordCheckIn(device.deviceId, {
      hardwareId: hardwareId ?? null,
      imageName,
      imageVersion,
      installedPackages: packages ?? null,
    });

    const { manifest, etag } = await this.bootstrap.manifestForRole(device.role);

    res.setHeader('ETag', etag);
    // The manifest is cheap and changes without warning — a tracked package
    // moves the moment a `.deb` is published — so revalidation is the point and
    // any freshness lifetime is wrong.
    res.setHeader('Cache-Control', 'no-cache');

    if (matchesEtag(ifNoneMatch, etag)) {
      res.status(304).end();
      return;
    }

    res.status(200).json({ success: true, data: manifest });
  }
}

/** `patrolkit-device/1.0.0` → `['patrolkit-device', '1.0.0']`. */
function splitImageHeader(header: string | undefined): [string | null, string | null] {
  if (!header) return [null, null];
  const slash = header.lastIndexOf('/');
  if (slash === -1) return [header, null];
  return [header.slice(0, slash) || null, header.slice(slash + 1) || null];
}

/**
 * Whether the client already holds this manifest.
 *
 * Tolerates the list form and the weak prefix even though our own client sends
 * back exactly what it was given: an intermediary is entitled to rewrite either,
 * and getting this wrong costs a full manifest on every check-in of every
 * device rather than an error anyone would notice.
 */
function matchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .includes(etag);
}
