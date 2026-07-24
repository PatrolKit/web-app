import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { DevicesService } from './devices.service';
import { ProvisionDeviceDto } from '../contracts/devices.contracts';
import type { DeviceListItem, ProvisionDeviceResponse } from '../contracts/devices.contracts';

@Controller('orgs/:orgId/devices')
@UseGuards(JwtAuthGuard, OrgContextGuard, PermissionsGuard)
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  @Get()
  @RequirePermissions('devices:read')
  listDevices(@Param('orgId') orgId: string): Promise<DeviceListItem[]> {
    return this.devicesService.listDevices(orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('devices:provision')
  provision(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ProvisionDeviceDto,
  ): Promise<ProvisionDeviceResponse> {
    return this.devicesService.provision(orgId, user.userId, body);
  }

  @Post(':id/rotate-secret')
  @HttpCode(200)
  @RequirePermissions('devices:provision')
  rotateSecret(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<{ clientSecret: string }> {
    return this.devicesService.rotateSecret(orgId, id, user.userId);
  }

  @Delete(':id')
  @HttpCode(200)
  @RequirePermissions('devices:revoke')
  revokeDevice(
    @Param('orgId') orgId: string,
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.devicesService.revokeDevice(orgId, id, user.userId);
  }
}
