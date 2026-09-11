import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { SuperAdminGuard } from '../../common/guards/super-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { TaxonomyService } from './taxonomy.service';
import { TaxonomyIconService } from './taxonomy-icon.service';
import {
  CreateTaxonomyNodeDto,
  MergeTaxonomyNodeDto,
  PatchTaxonomyNodeDto,
} from '../../contracts/taxonomy.contracts';

/**
 * The shared list, and the promotion inbox.
 *
 * `SuperAdminGuard` throughout, matching `PlatformController`: what every org
 * sees is not one org's to change. An org reaches its own overlay through
 * `TaxonomyController` and asks for a global change rather than making one
 * (D10).
 */
@Controller('admin/taxonomy')
@UseGuards(JwtAuthGuard, SuperAdminGuard)
export class TaxonomyAdminController {
  constructor(
    private readonly taxonomy: TaxonomyService,
    private readonly icons: TaxonomyIconService,
  ) {}

  /** The global tree, nested, for the editor (§6.4). */
  @Get()
  tree() {
    return this.taxonomy.globalTree();
  }

  /** Everything an org has asked to make shared. */
  @Get('suggestions')
  suggestions() {
    return this.taxonomy.suggestions();
  }

  @Post('nodes')
  @HttpCode(201)
  create(@Body() body: CreateTaxonomyNodeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.taxonomy.createNode(null, body, user.userId);
  }

  @Patch('nodes/:nodeId')
  patch(
    @Param('nodeId') nodeId: string,
    @Body() body: PatchTaxonomyNodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.taxonomy.patchNode(null, nodeId, body, user.userId, req.ip);
  }

  @Post('nodes/:nodeId/merge')
  @HttpCode(200)
  merge(
    @Param('nodeId') nodeId: string,
    @Body() body: MergeTaxonomyNodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.taxonomy.merge(null, nodeId, body.targetId, user.userId, req.ip);
  }

  /**
   * Moves an org node onto the shared list, ancestors first.
   *
   * A collision with an existing global label becomes a merge into it rather
   * than a refusal — which is the point of the two-tier scheme.
   */
  @Post('nodes/:nodeId/promote')
  @HttpCode(200)
  promote(
    @Param('nodeId') nodeId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.taxonomy.promote(nodeId, user.userId, req.ip);
  }

  // ─── Icons ─────────────────────────────────────────────────────────────────

  @Post('nodes/:nodeId/icon')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadIcon(
    @Param('nodeId') nodeId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string },
  ) {
    return this.icons.upload(nodeId, file, { orgId: null });
  }

  @Delete('nodes/:nodeId/icon')
  @HttpCode(204)
  async deleteIcon(@Param('nodeId') nodeId: string): Promise<void> {
    await this.icons.remove(nodeId, { orgId: null });
  }
}

/**
 * A global node's icon bytes, for a deployment with no bucket.
 *
 * Split out of the controller above because it is the one route here that is not
 * a platform admin's: every signed-in user renders these icons in an item form,
 * and a shared glyph is not org data. Same reasoning as the org route's
 * `:report` level.
 */
@Controller('admin/taxonomy')
@UseGuards(JwtAuthGuard)
export class TaxonomyAdminIconController {
  constructor(private readonly icons: TaxonomyIconService) {}

  @Get('nodes/:nodeId/icon')
  async getIcon(@Param('nodeId') nodeId: string, @Res() res: Response): Promise<void> {
    const bytes = await this.icons.read(nodeId);
    if (!bytes) {
      res.status(404).end();
      return;
    }
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(bytes);
  }
}
