import {
  BadRequestException,
  Body, Controller, Delete, Get, Headers, HttpCode, Param,
  Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { ItemService } from './item.service';
import { LegacyTicketService } from './legacy-ticket.service';
import { CreateItemDto, PatchItemDto } from '../contracts/ski-swap.contracts';
import type { Request } from 'express';

@Controller('orgs/:orgId/ski-swap/swaps/:swapId/items')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
@RequireModule('ski_swap')
export class ItemController {
  constructor(
    private readonly itemService: ItemService,
    private readonly tickets: LegacyTicketService,
  ) {}

  @Get()
  @RequirePermissions('ski_swap:report')
  list(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Query('query') query?: string,
    @Query('sellerId') sellerId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('updatedSince') updatedSince?: string,
    @Query('consigned') consigned?: string,
  ) {
    return this.itemService.list(orgId, swapId, {
      query,
      sellerId,
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
      updatedSince,
      consigned: consigned === undefined ? undefined : consigned === 'true',
    });
  }

  /**
   * One item by the number on its tag, exactly — what a scanner needs.
   *
   * A path segment rather than a search parameter because a SKU identifies the
   * item; `?query=` is the fuzzy search that already exists and would match
   * more than the tag in someone's hand.
   */
  @Get('by-sku/:sku')
  @RequirePermissions('ski_swap:report')
  findBySku(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('sku') sku: string,
  ) {
    return this.itemService.findBySku(orgId, swapId, sku);
  }

  /**
   * Accepts an item onto the floor, which is also what puts it in Square.
   *
   * Open to the staff iPad as well as to staff on the web: the whole point is
   * that someone standing at the table with the goods can do it.
   */
  @Post(':itemId/consign')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  consign(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('itemId') itemId: string,
    @Req() req: Request & { user?: { userId: string }; device?: { deviceId: string } },
  ) {
    const actorId = req.user?.userId ?? req.device?.deviceId ?? null;
    return this.itemService.consign(orgId, swapId, itemId, actorId);
  }

  /**
   * A shop's inventory, uploaded by staff on their behalf.
   *
   * The seller is named in the body rather than taken from the caller — that is
   * the whole feature — so the rules refuse any number outside the blocks
   * issued to them, which is what makes picking the wrong shop a failure rather
   * than a mess.
   */
  @Post('import')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  importForSeller(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('sellerId') sellerId: string,
  ) {
    if (!sellerId) throw new BadRequestException('Choose which seller the file is for.');
    const { rows } = this.tickets.parseItemCsv(file.buffer);
    return this.itemService.importForSeller(orgId, swapId, sellerId, rows);
  }

  /** Who staff may upload a file for: everyone holding tickets in this swap. */
  @Get('ticket-sellers')
  @RequirePermissions('ski_swap:report')
  ticketSellers(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.tickets.sellersWithRanges(orgId, swapId);
  }

  @Post()
  @RequirePermissions('ski_swap:manage')
  create(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: CreateItemDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.itemService.createAtStation(orgId, swapId, body, idempotencyKey);
  }

  @Get(':itemId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string) {
    return this.itemService.get(orgId, swapId, itemId);
  }

  @Patch(':itemId')
  @RequirePermissions('ski_swap:manage')
  patch(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string, @Body() body: PatchItemDto) {
    return this.itemService.patch(orgId, swapId, itemId, body);
  }

  @Delete(':itemId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async remove(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string) {
    await this.itemService.remove(orgId, swapId, itemId);
  }

  @Post(':itemId/photos')
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 10 * 1024 * 1024 } }))
  uploadPhoto(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.itemService.uploadPhoto(orgId, swapId, itemId, file);
  }

  @Delete(':itemId/photos/:photoId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async deletePhoto(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('itemId') itemId: string,
    @Param('photoId') photoId: string,
  ) {
    await this.itemService.deletePhoto(orgId, swapId, itemId, photoId);
  }
}
