import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';
import { PlatformService } from './platform.service';
import { CreateOrgDto, PlatformPatchOrgDto } from '../contracts/members.contracts';
import type { PlatformOrgResponse } from '../contracts/members.contracts';

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
