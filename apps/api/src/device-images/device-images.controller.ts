import { Controller, Get, NotFoundException, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { DeviceImagesService } from './device-images.service';
import type {
  DeviceImageResponse,
  DeviceImageDownload,
} from '../contracts/device-images.contracts';

/**
 * The image somebody writes to an SD card.
 *
 * Signed-in users, and no permission beyond that: the people who flash cards
 * are the people who own the devices, and putting platform administration
 * between a customer and a replacement for a card that died in a lift shack
 * helps nobody. The image holds no secrets — credentials reach a device later,
 * over BLE, during provisioning.
 *
 * One image, never a list. Which one is a platform decision made in Device
 * Software; offering customers the catalogue would be offering them versions
 * that were superseded for a reason.
 */
@Controller('device-images')
@UseGuards(JwtAuthGuard)
export class DeviceImagesController {
  constructor(private readonly images: DeviceImagesService) {}

  @Get('current')
  async current(): Promise<DeviceImageResponse | null> {
    const image = await this.images.current();
    if (!image) return null;
    // The S3 key never leaves the server: it is what gets presigned, and the
    // browser has no use for it.
    const { key: _key, ...rest } = image;
    return rest;
  }

  /**
   * Downloads only the promoted image, by design.
   *
   * The name and version are still in the path so the URL says what it fetches
   * and a stale page cannot silently download something else — but a request
   * for any other version is refused rather than served.
   */
  @Get(':name/:version/download')
  async download(
    @Param('name') name: string,
    @Param('version') version: string,
  ): Promise<DeviceImageDownload> {
    const current = await this.images.current();
    if (!current || current.name !== name || current.version !== version) {
      throw new NotFoundException('That image is not the current release');
    }
    return this.images.presign(name, version);
  }
}
