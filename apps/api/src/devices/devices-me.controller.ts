import { Controller, Get, UseGuards } from '@nestjs/common';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { DevicesService } from './devices.service';
import type { DeviceMeResponse } from '../contracts/devices.contracts';

@Controller('devices')
@UseGuards(DeviceAuthGuard)
export class DevicesMeController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get('me')
  getMe(@CurrentDevice() device: AuthenticatedDevice): Promise<DeviceMeResponse> {
    return this.devicesService.getDeviceMe(device.deviceId);
  }
}
