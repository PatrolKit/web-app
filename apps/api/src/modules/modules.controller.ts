import { Body, Controller, Get, HttpCode, Param, Patch, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { ModulesService } from './modules.service';
import type { ModuleResponse } from './modules.service';

const SetModuleEnabledSchema = z.object({ enabled: z.boolean() }).strict();
class SetModuleEnabledDto extends createZodDto(SetModuleEnabledSchema) {}

@Controller('orgs/:orgId/modules')
@UseGuards(JwtAuthGuard, OrgContextGuard, PermissionsGuard)
export class ModulesController {
  constructor(private readonly modulesService: ModulesService) {}

  @Get()
  @RequirePermissions('org:read')
  listModules(@Param('orgId') orgId: string): Promise<ModuleResponse[]> {
    return this.modulesService.listModules(orgId);
  }

  @Patch(':key')
  @HttpCode(200)
  @RequirePermissions('modules:manage')
  setEnabled(
    @Param('orgId') orgId: string,
    @Param('key') key: string,
    @Body() body: SetModuleEnabledDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ModuleResponse> {
    return this.modulesService.setModuleEnabled(orgId, key, body.enabled, user.userId);
  }
}
