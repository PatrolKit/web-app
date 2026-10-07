import { CheckinSessionAllowed } from '../common/decorators/checkin-session-allowed.decorator';
import { parseItemListView } from './item-list-order';
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
  Headers,
  NotFoundException,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { isImportGuideFile } from './import-guide';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { SellerProfileGuard } from '../common/guards/seller-profile.guard';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { SellerSelfService } from './seller-self.service';
import { PatchSellerDto, SellerItemCreateDto, SellerItemUpdateDto } from '../contracts/ski-swap.contracts';
import { PrinterService } from './printer.service';
import { ReprintItemDto } from '../contracts/ski-swap.contracts';
import { LegacyTicketService } from './legacy-ticket.service';

@Controller('orgs/:orgId/ski-swap/seller/me')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, SellerProfileGuard)
@RequireModule('ski_swap')
export class SellerSelfController {
  constructor(
    private readonly sellerSelfService: SellerSelfService,
    private readonly printerService: PrinterService,
    private readonly tickets: LegacyTicketService,
  ) {}

  /** The downloads beside a shop's upload (Plan 42): a template, an example, and the categories and details. */
  @Get('items/import/:file')
  async importGuide(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('file') file: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!isImportGuideFile(file)) throw new NotFoundException();
    const { csv, filename } = await this.sellerSelfService.importGuide(orgId, user.userId, file);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(csv);
  }

  /**
   * A whole inventory at once, for a shop with more items than patience.
   *
   * Checked in full before anything is written: a half-imported inventory is
   * worse than a rejected one, because the seller cannot tell which half.
   */
  @Post('items/import')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async importItems(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('swapId') swapId: string,
    // Multipart fields, so strings: "true" turns each on (Plans 31, 42).
    @Body('generateSkus') generateSkus?: string,
    @Body('acceptUnknown') acceptUnknown?: string,
  ) {
    return this.sellerSelfService.importItems(orgId, user.userId, swapId, this.tickets.parseItemCsv(file.buffer), {
      generateSkus: generateSkus === 'true',
      acceptUnknown: acceptUnknown === 'true',
    });
  }

  /**
   * The shop's tickets for its item form (Plan 38): the runs of numbers it
   * holds, the lowest nobody has described, and whether every one is.
   */
  @Get('ticket-state')
  async ticketState(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('swapId') swapId: string,
  ) {
    const seller = await this.sellerSelfService.getSellerRecord(orgId, user.userId);
    const state = await this.tickets.formState(swapId, seller.id);
    // Only a shop is on issued tickets: an individual's loose ticket from the
    // counter doesn't put their own page on tickets (Plan 38).
    return seller.businessName ? state : { ...state, ranges: [], suggested: null, exhausted: false };
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  @CheckinSessionAllowed()
  @Get()
  getProfile(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sellerSelfService.getProfile(orgId, user.userId);
  }

  @CheckinSessionAllowed()
  @Patch()
  updateProfile(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: PatchSellerDto,
  ) {
    return this.sellerSelfService.updateProfile(orgId, user.userId, body);
  }

  // ─── Active swaps (swap selector) ─────────────────────────────────────────

  @Get('swaps')
  listSwaps(@Param('orgId') orgId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.sellerSelfService.listActiveSwaps(orgId, user.userId);
  }

  // ─── Items ────────────────────────────────────────────────────────────────

  @Get('items')
  listItems(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('swapId') swapId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    /** The same filters and sort as the staff list (Plan 39). */
    @Query('status') status?: string,
    @Query('printed') printed?: string,
    @Query('sort') sort?: string,
    @Query('dir') dir?: string,
  ) {
    return this.sellerSelfService.listItems(orgId, user.userId, swapId, {
      skip: skip ? parseInt(skip, 10) : undefined,
      take: take ? parseInt(take, 10) : undefined,
      ...parseItemListView({ status, printed, sort, dir }),
    });
  }

  @CheckinSessionAllowed()
  @Post('items')
  createItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: SellerItemCreateDto,
    // Venue wifi drops mid-request. A retried save with the same key returns
    // the first item rather than minting a second SKU and a second tag.
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.sellerSelfService.createItem(orgId, user.userId, body, idempotencyKey);
  }

  /** For a tag that jammed, smudged, or never came out. */
  @CheckinSessionAllowed()
  @Post('items/:itemId/reprint')
  @HttpCode(202)
  reprintItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Body() body: ReprintItemDto,
  ) {
    return this.sellerSelfService.reprintItem(orgId, user.userId, itemId, body.stationId);
  }

  @Get('items/:itemId')
  getItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
  ) {
    return this.sellerSelfService.getItem(orgId, user.userId, itemId);
  }

  @Patch('items/:itemId')
  updateItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Body() body: SellerItemUpdateDto,
  ) {
    return this.sellerSelfService.updateItem(orgId, user.userId, itemId, body);
  }

  @Delete('items/:itemId')
  @HttpCode(204)
  deleteItem(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
  ) {
    return this.sellerSelfService.deleteItem(orgId, user.userId, itemId);
  }

  // ─── Photos ───────────────────────────────────────────────────────────────

  @CheckinSessionAllowed()
  @Post('items/:itemId/photos')
  @UseInterceptors(FileInterceptor('image'))
  uploadPhoto(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('stationId') stationId?: string,
  ) {
    return this.sellerSelfService.uploadPhoto(orgId, user.userId, itemId, file, stationId);
  }

  @Delete('items/:itemId/photos/:photoId')
  @HttpCode(204)
  deletePhoto(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('itemId') itemId: string,
    @Param('photoId') photoId: string,
  ) {
    return this.sellerSelfService.deletePhoto(orgId, user.userId, itemId, photoId);
  }

  // ─── Printers ─────────────────────────────────────────────────────────────

  @Get('printers')
  listPrinters(@Param('orgId') orgId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.printerService.listForSeller(orgId, user.userId);
  }
}
