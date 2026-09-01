import { Body, Controller, ForbiddenException, Get, HttpCode, Patch, UseGuards } from '@nestjs/common';
import { DeviceAuthGuard } from '../common/guards/device-auth.guard';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import { DevicesService } from './devices.service';
import { RebindDeviceDto } from '../contracts/devices.contracts';
import type { DeviceMeResponse } from '../contracts/devices.contracts';

@Controller('devices')
@UseGuards(DeviceAuthGuard)
export class DevicesMeController {
  constructor(private readonly devicesService: DevicesService) {}

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
}
