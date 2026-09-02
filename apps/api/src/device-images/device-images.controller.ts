import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DeviceImagesService } from './device-images.service';
import type {
  DeviceImageResponse,
  DeviceImageDownload,
} from '../contracts/device-images.contracts';

/**
 * Signed-in users only, and no permission beyond that.
 *
 * The people who flash cards are the people who own the devices, so gating this
 * behind platform administration would put a support call between a customer
 * and a replacement for a card that died in a lift shack. The image contains no
 * secrets — credentials reach a device later, over BLE, during provisioning.
 *
 * Not org-scoped either: there is one image and every org gets the same one.
 * Deliberately not mounted under a module, because it is not a signage image
 * and presenting it as one is how a base image quietly acquires per-module
 * variants nobody wanted to maintain.
 */
@Controller('device-images')
@UseGuards(JwtAuthGuard)
export class DeviceImagesController {
  constructor(private readonly images: DeviceImagesService) {}

  @Get()
  async list(): Promise<DeviceImageResponse[]> {
    const images = await this.images.list();
    // The S3 key never leaves the server: it is what gets presigned, and the
    // browser has no use for it.
    return images.map(({ key: _key, ...rest }) => rest);
  }

  @Get(':name/:version/download')
  download(
    @Param('name') name: string,
    @Param('version') version: string,
  ): Promise<DeviceImageDownload> {
    return this.images.presign(name, version);
  }
}
