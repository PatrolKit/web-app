import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { DeviceImagesService } from './device-images.service';
import { PromoteImageDto } from '../contracts/device-images.contracts';
import type {
  AdminDeviceImage,
  DeviceImageDownload,
} from '../contracts/device-images.contracts';

/**
 * Which image customers are offered.
 *
 * Super-admin only and not org-scoped, like the rest of Device Software: there
 * is one image for the whole fleet. Publishing and promoting are separate steps
 * on purpose, so an image can be built, published and flashed onto a bench card
 * before anybody else is offered it.
 */
@Controller('admin/device-images')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class DeviceImagesAdminController {
  constructor(private readonly images: DeviceImagesService) {}

  @Get()
  list(): Promise<AdminDeviceImage[]> {
    return this.images.listForAdmin();
  }

  @Post('promote')
  promote(
    @Body() body: PromoteImageDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AdminDeviceImage[]> {
    return this.images.promote(body.name, body.version, user.userId);
  }

  /** So an administrator can check a build before promoting it. */
  @Get(':name/:version/download')
  download(
    @Param('name') name: string,
    @Param('version') version: string,
  ): Promise<DeviceImageDownload> {
    return this.images.presign(name, version);
  }
}
