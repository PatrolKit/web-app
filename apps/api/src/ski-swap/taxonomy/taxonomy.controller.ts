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
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { OrDeviceAuthGuard } from '../../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../../common/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../../common/decorators/require-device-role.decorator';
import { RequireModule } from '../../common/decorators/require-module.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/guards/jwt-auth.guard';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { TaxonomyService } from './taxonomy.service';
import { TaxonomyIconService } from './taxonomy-icon.service';
import { isTaxonomyIconKey } from '../../contracts/taxonomy-icons';
import {
  CreateTaxonomyNodeDto,
  TaxonomyDepthQueryDto,
  CreateTaxonomyValueDto,
  MergeTaxonomyNodeDto,
  PatchTaxonomyNodeDto,
} from '../../contracts/taxonomy.contracts';

/**
 * The tree, as one org sees and curates it.
 *
 * `@RequireDeviceRole` sits on the read routes only, following
 * `SkiSwapSettingsController`: the check-in iPad needs the tree to draw a form,
 * and nothing here is a device's to write. `PermissionsGuard` refuses a device on
 * any route that does not name a role, so the writes need no code to say so.
 */
@Controller('orgs/:orgId/ski-swap/taxonomy')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class TaxonomyController {
  constructor(
    private readonly taxonomy: TaxonomyService,
    private readonly icons: TaxonomyIconService,
  ) {}

  /**
   * The resolved tree the item form is generated from (§4.1).
   *
   * **Org membership, and no permission beyond it.** This sat behind
   * `ski_swap:report` on the reasoning that a seller entering their own items
   * reads it too — but a seller has no ski-swap permissions at all. They are a
   * membership with a seller profile, which is how `seller-self` identifies one.
   * So somebody checking themselves in got a 403 on the one call the item form
   * cannot start without, and the form reported it as an empty tree.
   *
   * There is nothing here to protect. It is a list of the shapes an item can
   * be — "Skis", "Boots" — and `OrgContextGuard` has already proven an active
   * membership by the time this runs.
   */
  @Get()
  @RequireDeviceRole('ski_swap.staff_check_in')
  resolve(@Param('orgId') orgId: string, @Query() query: TaxonomyDepthQueryDto) {
    // `?depth=full` expands every deferred branch inline, for a client that
    // prefetches rather than loading on open. The default is unchanged.
    return this.taxonomy.resolve(orgId, { full: query.depth === 'full' });
  }

  /** A deferred branch — a manufacturer's model list — fetched on open (§7.2). */
  // Same reasoning as the resolve above: a seller opening a manufacturer's model
  // list is the same seller, one tap later.
  @Get('nodes/:nodeId/children')
  @RequireDeviceRole('ski_swap.staff_check_in')
  children(@Param('orgId') orgId: string, @Param('nodeId') nodeId: string) {
    return this.taxonomy.children(orgId, nodeId);
  }

  /** The queue and this org's own values, for the Administration tab (§6.3). */
  @Get('admin')
  @RequirePermissions('ski_swap:admin')
  admin(@Param('orgId') orgId: string) {
    return this.taxonomy.orgAdmin(orgId);
  }

  /** Staff adding a value deliberately, rather than a seller typing one. */
  @Post('values')
  @HttpCode(201)
  @RequirePermissions('ski_swap:manage')
  createValue(
    @Param('orgId') orgId: string,
    @Body() body: CreateTaxonomyValueDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taxonomy.mintValue(orgId, body.attributeId, body.label, {
      approved: body.approved,
      actorId: user.userId,
    });
  }

  /**
   * An org adding a question or a category of its own.
   *
   * The same endpoint the platform editor has, scoped to this org. An org that
   * runs a swap the shared list does not describe should not have to wait for a
   * release either.
   */
  @Post('nodes')
  @HttpCode(201)
  @RequirePermissions('ski_swap:admin')
  createNode(
    @Param('orgId') orgId: string,
    @Body() body: CreateTaxonomyNodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taxonomy.createNode(orgId, body, user.userId);
  }

  /** Approve · rename · reorder · retire · set an icon key. */
  @Patch('nodes/:nodeId')
  @RequirePermissions('ski_swap:admin')
  patchNode(
    @Param('orgId') orgId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: PatchTaxonomyNodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.taxonomy.patchNode(orgId, nodeId, body, user.userId, req.ip);
  }

  /** "Use that instead" — folds this value into another (§8.3). */
  @Post('nodes/:nodeId/merge')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  merge(
    @Param('orgId') orgId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: MergeTaxonomyNodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.taxonomy.merge(orgId, nodeId, body.targetId, user.userId, req.ip);
  }

  /** "Suggest for everyone" — the org asks; a platform admin decides (§8.4). */
  @Post('nodes/:nodeId/suggest')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  suggest(
    @Param('orgId') orgId: string,
    @Param('nodeId') nodeId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.taxonomy.suggest(orgId, nodeId, user.userId);
  }

  /** Deletes a value of the org's own, pending or approved, that nothing points at or hangs off. */
  @Delete('nodes/:nodeId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:admin')
  async discard(@Param('orgId') orgId: string, @Param('nodeId') nodeId: string): Promise<void> {
    await this.taxonomy.discard(orgId, nodeId);
  }

  /**
   * A built-in mark, rendered (iOS handoff, Ask J).
   *
   * 128×128 PNG, monochrome with alpha, so a native client can draw it as a
   * template — shape from the alpha channel, colour from the view. The web does
   * not call this: it has the glyph in its own bundle and reads `icon.key`.
   *
   * Read at `:report` and open to the check-in iPad, like the tree these belong
   * to. The bytes for a key never change, so they are served immutable.
   */
  @Get('icons/:file')
  @RequireDeviceRole('ski_swap.staff_check_in')
  @RequirePermissions('ski_swap:report')
  async getRegistryIcon(@Param('file') file: string, @Res() res: Response): Promise<void> {
    const key = file.replace(/\.png$/i, '');
    // Checked against the contract's list rather than the filesystem: `key`
    // arrives from a URL, and a path built from unvalidated input is how a
    // traversal gets in.
    if (!isTaxonomyIconKey(key)) {
      res.status(404).end();
      return;
    }
    const path = join(__dirname, 'assets', `${key}.png`);
    try {
      const bytes = await readFile(path);
      res.set('Content-Type', 'image/png');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.send(bytes);
    } catch {
      // A key the contract knows but no render exists for: the generator has not
      // been run since it was added. A 404 reads as "no icon", which the client
      // already handles, rather than a 500.
      res.status(404).end();
    }
  }

  // ─── Icons ─────────────────────────────────────────────────────────────────

  @Post('nodes/:nodeId/icon')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  uploadIcon(
    @Param('orgId') orgId: string,
    @Param('nodeId') nodeId: string,
    @UploadedFile() file: { buffer: Buffer; mimetype: string },
  ) {
    return this.icons.upload(nodeId, file, { orgId });
  }

  @Delete('nodes/:nodeId/icon')
  @HttpCode(204)
  @RequirePermissions('ski_swap:admin')
  async deleteIcon(
    @Param('orgId') orgId: string,
    @Param('nodeId') nodeId: string,
  ): Promise<void> {
    await this.icons.remove(nodeId, { orgId });
  }

  /**
   * The bytes, when there is no bucket to serve them from.
   *
   * Read at `:report` like the tree itself — whoever can see an icon in a form
   * can fetch it. Cached hard: the URL changes only when the node does, and a
   * phone fetching thirteen of these on arrival should fetch them once.
   */
  @Get('nodes/:nodeId/icon')
  @RequireDeviceRole('ski_swap.staff_check_in')
  @RequirePermissions('ski_swap:report')
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
