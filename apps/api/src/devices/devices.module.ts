import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesMeController } from './devices-me.controller';
import { DevicesService } from './devices.service';
import { SkuService } from '../ski-swap/sku.service';
import { AuthModule } from '../auth/auth.module';
import { BootstrapModule } from '../bootstrap/bootstrap.module';

@Module({
  imports: [AuthModule, BootstrapModule],
  controllers: [DevicesController, DevicesMeController],
  providers: [DevicesService, SkuService],
})
export class DevicesModule {}
