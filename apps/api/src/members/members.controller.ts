import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
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
import { ImportMembersDto, InviteMemberDto, UpdateMemberDto } from '../contracts/members.contracts';
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

  /** Reads the file and guesses its columns; nothing is written (Plan 57 D10). */
  @Post('import/parse')
  @HttpCode(200)
  @RequirePermissions('users:import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  parseImport(@UploadedFile() file: Express.Multer.File) {
    if (!file?.buffer) throw new BadRequestException('No file uploaded');
    const { headers, rows, mapping } = this.membersService.parseImportFile(file.buffer);
    return { headers, mapping, preview: rows.slice(0, 5), rows, totalRows: rows.length };
  }

  /** The mapped rows, once someone has checked them. */
  @Post('import')
  @HttpCode(200)
  @RequirePermissions('users:import')
  importMembers(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ImportMembersDto,
  ): Promise<ImportOutcome[]> {
    return this.membersService.importRows(orgId, user.userId, body);
  }

  /** Emails the member where and how to sign in. Doesn't expire, unlike a sign-in link. */
  @Post(':userId/invite')
  @HttpCode(200)
  @RequirePermissions('users:invite')
  sendInvite(@Param('orgId') orgId: string, @Param('userId') userId: string) {
    return this.membersService.sendInvite(orgId, userId);
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
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<void> {
    return this.membersService.removeMember(orgId, userId, actor.userId);
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
