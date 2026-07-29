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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { MembersService } from './members.service';
import { InviteMemberDto, UpdateMemberDto } from '../contracts/members.contracts';
import type { MemberResponse, ImportOutcome } from '../contracts/members.contracts';

@Controller('orgs/:orgId/members')
@UseGuards(JwtAuthGuard, OrgContextGuard, PermissionsGuard)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @RequirePermissions('users:read')
  listMembers(@Param('orgId') orgId: string): Promise<MemberResponse[]> {
    return this.membersService.listMembers(orgId);
  }

  @Post()
  @HttpCode(201)
  @RequirePermissions('users:invite')
  inviteMember(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: InviteMemberDto,
  ): Promise<MemberResponse> {
    return this.membersService.inviteMember(orgId, user.userId, body);
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('users:import')
  @UseInterceptors(FileInterceptor('file'))
  async bulkImport(
    @Param('orgId') orgId: string,
    @UploadedFile() file: Express.Multer.File,
    @Query('sendInvites') sendInvitesParam?: string,
  ): Promise<ImportOutcome[]> {
    const sendInvites = sendInvitesParam === 'true';
    return this.membersService.bulkImport(orgId, file.buffer, sendInvites);
  }

  @Patch(':userId')
  @HttpCode(200)
  updateMember(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @Body() body: UpdateMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MemberResponse> {
    return this.membersService.updateMember(orgId, userId, body, actor.userId);
  }

  @Delete(':userId')
  @HttpCode(200)
  @RequirePermissions('users:manage')
  removeMember(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
  ): Promise<void> {
    return this.membersService.removeMember(orgId, userId);
  }
}

@Controller('orgs/:orgId/permissions')
@UseGuards(JwtAuthGuard, OrgContextGuard, PermissionsGuard)
export class PermissionsCatalogController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  @RequirePermissions('users:read')
  getCatalog(): Promise<{ key: string; description: string }[]> {
    return this.membersService.getPermissionsCatalog();
  }
}
