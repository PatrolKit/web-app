import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
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

  @Get('logo')
  @RequirePermissions('org:read')
  async getLogo(@Param('orgId') orgId: string, @Res() res: Response): Promise<void> {
    const org = await this.orgsService.getOrg(orgId);
    if (!org.logoUrl) { res.status(404).end(); return; }

    if (org.logoUrl.startsWith('data:')) {
      const [header, b64] = org.logoUrl.split(',');
      const mime = header.split(':')[1].split(';')[0];
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(Buffer.from(b64, 'base64'));
      return;
    }

    const upstream = await fetch(org.logoUrl);
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', upstream.headers.get('content-type') ?? 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buf);
  }

  @Post('logo')
  @HttpCode(200)
  @RequirePermissions('org:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadLogo(@Param('orgId') orgId: string, @UploadedFile() file: Express.Multer.File): Promise<OrgResponse> {
    if (!file?.buffer) throw new BadRequestException('No file uploaded');
    return this.orgsService.uploadLogo(orgId, { buffer: file.buffer, mimetype: file.mimetype });
  }

  @Delete('logo')
  @HttpCode(200)
  @RequirePermissions('org:manage')
  deleteLogo(@Param('orgId') orgId: string): Promise<OrgResponse> {
    return this.orgsService.deleteLogo(orgId);
  }
}
