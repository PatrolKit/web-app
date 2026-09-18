import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard, type AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PayPalConfigService } from './paypal-config.service';
import { UpsertPayPalConfigDto } from '../../contracts/payouts.contracts';

/**
 * PayPal credentials, beside Square's on the Administration tab.
 *
 * Every route is `ski_swap:admin` except the status read, which anybody who can
 * see a report needs in order to be told why the payouts screen is empty.
 */
@Controller('orgs/:orgId/ski-swap/paypal-config')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class PayPalConfigController {
  constructor(private readonly configService: PayPalConfigService) {}

  @Get()
  @RequirePermissions('ski_swap:admin')
  get(@Param('orgId') orgId: string) {
    return this.configService.get(orgId);
  }

  @Get('status')
  @RequirePermissions('ski_swap:report')
  status(@Param('orgId') orgId: string) {
    return this.configService.status(orgId);
  }

  @Put()
  @RequirePermissions('ski_swap:admin')
  upsert(
    @Param('orgId') orgId: string,
    @Body() body: UpsertPayPalConfigDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.configService.upsert(orgId, body, user.userId, req.ip);
  }

  @Delete()
  @HttpCode(204)
  @RequirePermissions('ski_swap:admin')
  async remove(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.configService.remove(orgId, user.userId, req.ip);
  }

  @Post('test')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  testConnection(@Param('orgId') orgId: string) {
    return this.configService.testConnection(orgId);
  }
}
