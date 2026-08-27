import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { type AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SwapService } from './swap.service';
import { CreateSwapDto, PatchSwapDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/swaps')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
@RequireModule('ski_swap')
export class SwapController {
  constructor(private readonly swapService: SwapService) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(@Param('orgId') orgId: string, @Query('active') active?: string) {
    return this.swapService.list(orgId, active === 'true');
  }

  @Post()
  @RequirePermissions('ski_swap:admin')
  create(
    @Param('orgId') orgId: string,
    @Body() body: CreateSwapDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.swapService.create(orgId, body.title, body.locationId, user.userId);
  }

  @Get(':swapId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.swapService.get(orgId, swapId);
  }

  @Patch(':swapId')
  @RequirePermissions('ski_swap:admin')
  patch(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: PatchSwapDto,
  ) {
    return this.swapService.patch(orgId, swapId, body);
  }

  @Delete(':swapId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:admin')
  async remove(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    await this.swapService.remove(orgId, swapId);
  }
}
