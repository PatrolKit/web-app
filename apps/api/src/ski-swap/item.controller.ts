import {
  BadRequestException,
  Body, Controller, Delete, Get, Headers, HttpCode, Param,
  Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { DeviceStockInterceptor } from './device-stock.interceptor';
import { parseItemListView } from './item-list-order';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { NoDeviceAccess, RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { ItemService, decodeCursor } from './item.service';
import { LegacyTicketService } from './legacy-ticket.service';
import { IssuedTicketService } from './issued-ticket.service';
import { BatchTicketsDto, CreateItemDto, PatchItemDto } from '../contracts/ski-swap.contracts';
import type { Request } from 'express';

@Controller('orgs/:orgId/ski-swap/swaps/:swapId/items')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
@RequireModule('ski_swap')
// Item responses to a device carry no stock, and read none (Plan 39 D8).
@UseInterceptors(DeviceStockInterceptor)
export class ItemController {
  constructor(
    private readonly itemService: ItemService,
    private readonly tickets: LegacyTicketService,
    private readonly issued: IssuedTicketService,
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
    /**
     * A stable walk of every item, for the client that mirrors them all
     * (iOS Plan 17 E).
     *
     * Orders by `(updatedAt, id)` and pages by a cursor instead of an offset,
     * so an item inserted by another station mid-walk cannot shift a live one
     * off the end of a page — which a client that deletes whatever did not come
     * back then deletes locally.
     */
    @Query('walk') walk?: string,
    @Query('after') after?: string,
    /** The Items page's filters and sort (Plan 39). */
    @Query('status') status?: string,
    @Query('printed') printed?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ) {
    const cursor = after ? decodeCursor(after) : null;
    if (after && !cursor) throw new BadRequestException('That page cursor is not one of ours.');
    const view = parseItemListView({ status, printed, sort, dir });

    return this.itemService.list(orgId, swapId, {
      query,
      sellerId,
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
      updatedSince,
      consigned: consigned === undefined ? undefined : consigned === 'true',
      // A cursor implies the walk it came from, so a client paging through one
      // cannot accidentally drop back to offset order on page two.
      walk: walk === 'true' || !!cursor,
      ...(cursor ? { after: cursor } : {}),
      ...view,
    });
  }

  /**
   * Whether one scanned ticket is free (Plan 40 D9): our rows only, no Square.
   * Asked once per scan by the Batch add popover.
   */
  @Get('ticket-check')
  @RequirePermissions('ski_swap:manage')
  ticketCheck(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Query('sku') sku?: string) {
    if (!sku) throw new BadRequestException('sku is required');
    return this.issued.ticketCheck(orgId, swapId, sku.trim());
  }

  /**
   * Batch add (Plan 40): the scanned tickets become the seller's items, on
   * sale with no price, Square following in the background.
   */
  @Post('batch-tickets')
  @RequirePermissions('ski_swap:manage')
  @NoDeviceAccess()
  batchTickets(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: BatchTicketsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.issued.batchAdd(orgId, swapId, body.sellerId, body.tickets, user.userId, idempotencyKey);
  }

  /**
   * A seller's items in the swap, for the Receipt popup (Plan 39 D7): how many,
   * their listed value as checked in, and how many still need a price. Our own
   * rows only; no Square read.
   */
  @Get('summary')
  @RequirePermissions('ski_swap:report')
  summary(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Query('sellerId') sellerId?: string) {
    if (!sellerId) throw new BadRequestException('sellerId is required');
    return this.itemService.sellerSummary(orgId, swapId, sellerId);
  }

  /**
   * One item by the number on its tag, exactly — what a scanner needs.
   *
   * A path segment rather than a search parameter because a SKU identifies the
   * item; `?query=` is the fuzzy search that already exists and would match
   * more than the tag in someone's hand.
   */
  /** Whether the swap's accepted tickets are all in Square, for the Items page's resume (Plan 38). */
  @Get('ticket-push')
  @RequirePermissions('ski_swap:report')
  ticketPushStatus(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.issued.swapPushStatus(orgId, swapId);
  }

  /** Puts the swap's accepted tickets that aren't in Square there, in the background. */
  @Post('ticket-push')
  @HttpCode(202)
  @RequirePermissions('ski_swap:admin')
  pushTickets(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    void this.issued.push(orgId, swapId);
    return { started: true };
  }

  /** Tickets with no price yet, for the fast edit (Plan 37). Light: no Square, no photos. */
  @Get('unpriced-tickets')
  @RequirePermissions('ski_swap:manage')
  unpricedTickets(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.itemService.unpricedTickets(orgId, swapId);
  }

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
   * Accepts everything one seller is still waiting on.
   *
   * Scoped to a seller rather than to the screen: the items page shows fifty
   * rows at a time and filters what it has, so a button acting on "what you can
   * see" would leave the rest of a shop's inventory behind without saying so.
   *
   * Web only, for now. The class opens every route to a check-in iPad, and this
   * one overrides that: accepting a shop's whole delivery in one press is a
   * decision we would rather see made on a screen showing the list, until the
   * iPad has a batch mode built around it. The scanner's job — one tag at a
   * time, with the goods in hand — is untouched.
   *
   * Nothing about the service is device-specific, so this is one decorator to
   * remove when that lands.
   */
  @Post('consign')
  @HttpCode(200)
  @NoDeviceAccess()
  @RequirePermissions('ski_swap:manage')
  consignAll(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body('sellerId') sellerId: string,
    @Req() req: Request & { user?: { userId: string }; device?: { deviceId: string } },
  ) {
    if (!sellerId) throw new BadRequestException('Choose which seller to accept items for.');
    const actorId = req.user?.userId ?? req.device?.deviceId ?? null;
    return this.itemService.consignAllForSeller(orgId, swapId, sellerId, actorId);
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
    // A multipart field, so a string: "true" turns it on (Plan 31).
    @Body('generateSkus') generateSkus?: string,
  ) {
    if (!sellerId) throw new BadRequestException('Choose which seller the file is for.');
    const { rows } = this.tickets.parseItemCsv(file.buffer);
    return this.itemService.importForSeller(orgId, swapId, sellerId, rows, generateSkus === 'true');
  }

  /**
   * Who staff may upload a file for: everyone holding tickets in this swap,
   * and, when its web isn't tickets-only, every business seller (Plan 31).
   */
  @Get('ticket-sellers')
  @RequirePermissions('ski_swap:report')
  ticketSellers(@Param('orgId') orgId: string, @Param('swapId') swapId: string) {
    return this.tickets.sellersWithTickets(orgId, swapId);
  }

  @Post()
  @RequirePermissions('ski_swap:manage')
  create(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Body() body: CreateItemDto,
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // `actorId` so a value typed at the counter is attributable. Absent when a
    // device is the caller rather than a person: this route takes
    // `OrDeviceAuthGuard`, and a station iPad has no user id to credit. Staff
    // or a staff iPad either way, so a value typed here is approved.
    return this.itemService.createAtStation(
      orgId,
      swapId,
      { ...body, ...(user?.userId ? { actorId: user.userId } : {}), approveNewValues: true },
      idempotencyKey,
    );
  }

  @Get(':itemId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('swapId') swapId: string, @Param('itemId') itemId: string) {
    return this.itemService.get(orgId, swapId, itemId);
  }

  @Patch(':itemId')
  @RequirePermissions('ski_swap:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('swapId') swapId: string,
    @Param('itemId') itemId: string,
    @Body() body: PatchItemDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // Staff: a value typed here is approved.
    return this.itemService.patch(orgId, swapId, itemId, { ...body, approveNewValues: true }, idempotencyKey);
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
    /*
     * The one where a lost response costs something visible: a retried upload
     * is a second copy of the same photo on the item, in S3 and in Square.
     */
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.itemService.uploadPhoto(orgId, swapId, itemId, file, idempotencyKey);
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
