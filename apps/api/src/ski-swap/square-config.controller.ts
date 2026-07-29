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
import { JwtAuthGuard, type AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SquareConfigService } from './square-config.service';
import { UpsertSquareConfigDto } from '../contracts/ski-swap.contracts';

@Controller('orgs/:orgId/ski-swap/config')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class SquareConfigController {
  constructor(private readonly configService: SquareConfigService) {}

  @Get()
  @RequirePermissions('ski_swap:admin')
  get(@Param('orgId') orgId: string) {
    return this.configService.get(orgId);
  }

  @Put()
  @RequirePermissions('ski_swap:admin')
  upsert(
    @Param('orgId') orgId: string,
    @Body() body: UpsertSquareConfigDto,
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

  @Get('locations')
  @RequirePermissions('ski_swap:admin')
  listLocations(@Param('orgId') orgId: string) {
    return this.configService.listLocations(orgId);
  }

  @Get('status')
  @RequirePermissions('ski_swap:report')
  async status(@Param('orgId') orgId: string) {
    const exists = await this.configService.exists(orgId);
    return { squareConfigured: exists };
  }
}
