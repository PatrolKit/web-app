import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { DevicesService } from './devices.service';
import { getTabletPin, setTabletPin } from './tablet-pin';
import { UpdateDevicePinDto } from '../contracts/devices.contracts';
import type { DeviceListItem, DevicePinResponse } from '../contracts/devices.contracts';

/**
 * The Tablets page (Plan 56): every iPad in the org, and the PIN that guards
 * them. Org administrators only. Adding, renaming, a new code and revoking go
 * through `orgs/:orgId/devices`, which lets an org admin manage any iPad.
 */
@Controller('orgs/:orgId/tablets')
@UseGuards(JwtAuthGuard, OrgContextGuard, PermissionsGuard)
@RequirePermissions('org:manage')
export class TabletsController {
  constructor(
    private readonly devices: DevicesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Param('orgId') orgId: string): Promise<DeviceListItem[]> {
    return this.devices.listTablets(orgId);
  }

  @Get('pin')
  getPin(@Param('orgId') orgId: string): Promise<DevicePinResponse> {
    return getTabletPin(this.prisma, orgId);
  }

  @Put('pin')
  setPin(
    @Param('orgId') orgId: string,
    @Body() body: UpdateDevicePinDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<DevicePinResponse> {
    return setTabletPin(this.prisma, orgId, body.devicePin, user.userId, req.ip);
  }
}
