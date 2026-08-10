import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { BusinessSellerService } from './business-seller.service';
import {
  InviteBusinessSellerDto,
  UpdateBusinessSellerStatusDto,
} from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/business-sellers')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
@RequirePermissions('ski_swap:admin')
export class BusinessSellerController {
  constructor(private readonly businessSellerService: BusinessSellerService) {}

  @Post()
  @HttpCode(201)
  invite(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: InviteBusinessSellerDto,
  ) {
    return this.businessSellerService.invite(orgId, user.userId, body);
  }

  @Get()
  list(@Param('orgId') orgId: string) {
    return this.businessSellerService.list(orgId);
  }

  @Patch(':userId/status')
  setStatus(
    @Param('orgId') orgId: string,
    @Param('userId') targetUserId: string,
    @Body() body: UpdateBusinessSellerStatusDto,
  ) {
    return this.businessSellerService.setStatus(orgId, targetUserId, body.status);
  }
}
