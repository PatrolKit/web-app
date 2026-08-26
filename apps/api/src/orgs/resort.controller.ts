import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { ResortService } from './resort.service';
import { CreateResortDto, PatchResortDto } from '../contracts/org.contracts';

/**
 * Resorts belong to the org, not to time tracking — the time-clock module
 * consumes them, so this is deliberately outside its module gate. Devices are
 * allowed to list (a TimeClock iPad binds itself to a resort at setup).
 */
@Controller('orgs/:orgId/resorts')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, PermissionsGuard)
@RequireDeviceRole('Time Clock')
export class ResortController {
  constructor(private readonly resortService: ResortService) {}

  /**
   * No permission beyond active membership: the hours report and the shift
   * filters need the resort list, and those readers don't necessarily hold
   * `org:read`. OrgContextGuard already proved they belong to this org.
   */
  @Get()
  list(@Param('orgId') orgId: string, @Query('updatedSince') updatedSince?: string) {
    return this.resortService.list(orgId, updatedSince);
  }

  @Post()
  @RequirePermissions('org:manage')
  create(@Param('orgId') orgId: string, @Body() body: CreateResortDto) {
    return this.resortService.create(orgId, body);
  }

  @Patch(':resortId')
  @RequirePermissions('org:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('resortId') resortId: string,
    @Body() body: PatchResortDto,
  ) {
    return this.resortService.patch(orgId, resortId, body);
  }

  @Delete(':resortId')
  @HttpCode(204)
  @RequirePermissions('org:manage')
  async remove(@Param('orgId') orgId: string, @Param('resortId') resortId: string) {
    await this.resortService.remove(orgId, resortId);
  }
}
