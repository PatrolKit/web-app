import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { BootstrapService } from './bootstrap.service';
import { ProfileInputDto, RepositoryInputDto } from '../contracts/bootstrap.contracts';
import type {
  ManifestPreview, ProfileResponse, RepositoryResponse,
} from '../contracts/bootstrap.contracts';

/**
 * What every PatrolKit device runs, and where it comes from.
 *
 * Super-admin only, and not scoped to an org — the same reason the models have
 * no `orgId`. This is where "this device is a signage device, here is the
 * package and version to run" is expressed, replacing a choice that used to be
 * baked into an image at build time.
 */
@Controller('admin/bootstrap')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class BootstrapAdminController {
  constructor(
    private readonly admin: BootstrapAdminService,
    private readonly bootstrap: BootstrapService,
  ) {}

  // ─── Repositories ──────────────────────────────────────────────────────────

  @Get('repositories')
  listRepositories(): Promise<RepositoryResponse[]> {
    return this.admin.listRepositories();
  }

  @Post('repositories')
  @HttpCode(201)
  createRepository(
    @Body() body: RepositoryInputDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RepositoryResponse> {
    return this.admin.createRepository(body, user.userId);
  }

  @Patch('repositories/:id')
  @HttpCode(200)
  updateRepository(
    @Param('id') id: string,
    @Body() body: RepositoryInputDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RepositoryResponse> {
    return this.admin.updateRepository(id, body, user.userId);
  }

  @Delete('repositories/:id')
  @HttpCode(200)
  deleteRepository(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.admin.deleteRepository(id, user.userId);
  }

  // ─── Profiles ──────────────────────────────────────────────────────────────

  @Get('profiles')
  listProfiles(): Promise<ProfileResponse[]> {
    return this.admin.listProfiles();
  }

  @Get('profiles/:role')
  getProfile(@Param('role') role: string): Promise<ProfileResponse> {
    return this.admin.getProfile(role);
  }

  @Patch('profiles/:role')
  @HttpCode(200)
  upsertProfile(
    @Param('role') role: string,
    @Body() body: ProfileInputDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProfileResponse> {
    return this.admin.upsertProfile(role, body, user.userId);
  }

  /**
   * Exactly what a device of this role would be served, and under what ETag.
   *
   * The only way to be sure before a fleet acts on it. It reports a failure as
   * a value rather than throwing, because "this cannot currently be resolved"
   * is precisely the answer the page exists to show.
   */
  @Get('profiles/:role/preview')
  preview(@Param('role') role: string): Promise<ManifestPreview> {
    return this.bootstrap.previewForRole(role);
  }
}
