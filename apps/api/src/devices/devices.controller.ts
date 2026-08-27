import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { DevicesService } from './devices.service';
import { ProvisionDeviceDto } from '../contracts/devices.contracts';
import type { DeviceListItem, ProvisionDeviceResponse } from '../contracts/devices.contracts';

@Controller('orgs/:orgId/devices')
@UseGuards(JwtAuthGuard, OrgContextGuard, PermissionsGuard)
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  // No @RequirePermissions here or below: which permission applies depends on
  // the device's role, which the decorator cannot see. The service resolves it
  // per device and refuses what the caller does not administer.
  @Get()
  listDevices(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DeviceListItem[]> {
    return this.devicesService.listDevices(orgId, user.userId);
  }

  @Post()
  @HttpCode(201)
  provision(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ProvisionDeviceDto,
  ): Promise<ProvisionDeviceResponse> {
    return this.devicesService.provision(orgId, user.userId, body);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  rotateSecret(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ clientSecret: string }> {
    return this.devicesService.rotateSecret(orgId, id, user.userId);
  }

  @Delete(':id')
  @HttpCode(200)
  revokeDevice(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.devicesService.revokeDevice(orgId, id, user.userId);
  }
}
