import { Body, Controller, Get, HttpCode, Param, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { OrgsService } from './orgs.service';
import { PatchOrgDto } from '../contracts/org.contracts';
import type { OrgResponse } from '../contracts/org.contracts';

@Controller('orgs/:orgId')
@UseGuards(JwtAuthGuard, OrgContextGuard, PermissionsGuard)
export class OrgsController {
  constructor(private readonly orgsService: OrgsService) {}

  @Get()
  @RequirePermissions('org:read')
  getOrg(@Param('orgId') orgId: string): Promise<OrgResponse> {
    return this.orgsService.getOrg(orgId);
  }

  @Patch()
  @HttpCode(200)
  @RequirePermissions('org:manage')
  patchOrg(@Param('orgId') orgId: string, @Body() body: PatchOrgDto): Promise<OrgResponse> {
    return this.orgsService.patchOrg(orgId, body);
  }
}
