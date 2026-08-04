import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesMeController } from './devices-me.controller';
import { DevicesService } from './devices.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [DevicesController, DevicesMeController],
  providers: [DevicesService],
})
export class DevicesModule {}
