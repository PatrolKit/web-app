import { Module } from '@nestjs/common';
import { DeviceImagesService } from './device-images.service';
import { DeviceImagesController } from './device-images.controller';

/**
 * Where a device image comes from.
 *
 * Platform-scoped, like BootstrapModule and for the same reason: the fleet runs
 * PatrolKit's software from PatrolKit's bucket, and there is exactly one image
 * for every org and every module.
 */
@Module({
  controllers: [DeviceImagesController],
  providers: [DeviceImagesService],
  exports: [DeviceImagesService],
})
export class DeviceImagesModule {}
