import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { PlatformService } from './platform.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import {
  AddMembershipDto, CreateOrgDto, PlatformPatchOrgDto, PlatformUserQueryDto,
} from '../contracts/members.contracts';
import type { PlatformOrgResponse, PlatformUserPage } from '../contracts/members.contracts';

@Controller('admin/organizations')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class PlatformController {
  constructor(private readonly platformService: PlatformService) {}

  @Get()
  listOrgs(): Promise<PlatformOrgResponse[]> {
    return this.platformService.listOrgs();
  }

  @Post()
  @HttpCode(201)
  createOrg(@Body() body: CreateOrgDto): Promise<PlatformOrgResponse> {
    return this.platformService.createOrg(body);
  }

  @Get(':id')
  getOrg(@Param('id') id: string): Promise<PlatformOrgResponse> {
    return this.platformService.getOrg(id);
  }

  @Patch(':id')
  @HttpCode(200)
  patchOrg(@Param('id') id: string, @Body() body: PlatformPatchOrgDto): Promise<PlatformOrgResponse> {
    return this.platformService.patchOrg(id, body);
  }

  @Delete(':id')
  @HttpCode(200)
  deleteOrg(@Param('id') id: string): Promise<void> {
    return this.platformService.deleteOrg(id);
  }
}

/**
 * Everyone on the platform, whether or not they belong anywhere.
 *
 * Separate from the organisations controller because it is not scoped to one:
 * the users worth finding here are precisely the ones no org would list.
 */
@Controller('admin/users')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class PlatformUsersController {
  constructor(private readonly platformService: PlatformService) {}

  @Get()
  list(@Query() query: PlatformUserQueryDto): Promise<PlatformUserPage> {
    return this.platformService.listUsers(query);
  }

  @Post(':id/memberships')
  @HttpCode(201)
  addMembership(@Param('id') id: string, @Body() body: AddMembershipDto): Promise<void> {
    return this.platformService.addMembership(id, body.orgId);
  }

  @Delete(':id/memberships/:membershipId')
  @HttpCode(200)
  removeMembership(
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
  ): Promise<void> {
    return this.platformService.removeMembership(id, membershipId);
  }

  @Delete(':id')
  @HttpCode(200)
  deleteUser(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.platformService.deleteUser(id, user.userId);
  }
}
