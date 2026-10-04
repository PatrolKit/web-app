import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { SellerService } from './seller.service';
import { ContactChallengeService } from '../auth/contact-challenge.service';
import { NOT_NORTH_AMERICAN, SMS_OFF, SmsService } from '../sms/sms.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentDevice } from '../common/decorators/current-device.decorator';
import type { AuthenticatedDevice } from '../common/guards/device-auth.guard';
import type { AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { AddTicketRangeDto, CreateSellerDto, PatchSellerDto, PersonSearchDto, AddSellerFromPersonDto } from '../contracts/ski-swap.contracts';
import { LegacyTicketService } from './legacy-ticket.service';

@Controller('orgs/:orgId/ski-swap/sellers')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')
@RequireModule('ski_swap')
export class SellerController {
  constructor(
    private readonly sellerService: SellerService,
    private readonly challenges: ContactChallengeService,
    private readonly sms: SmsService,
    private readonly tickets: LegacyTicketService,
  ) {}

  // ─── Legacy ticket ranges ─────────────────────────────────────────────────

  /**
   * The blocks issued to this seller for a swap, with how much of each is
   * spent. Swap-scoped, so the caller says which one.
   */
  @Get(':sellerId/ticket-ranges')
  @RequirePermissions('ski_swap:report')
  listTicketRanges(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Query('swapId') swapId: string,
  ) {
    return this.tickets.listForSellerWithUse(orgId, swapId, sellerId);
  }

  @Post(':sellerId/ticket-ranges')
  @HttpCode(201)
  @RequirePermissions('ski_swap:admin')
  addTicketRange(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Body() body: AddTicketRangeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tickets.addRange(orgId, body.swapId, sellerId, body, user.userId);
  }

  @Delete(':sellerId/ticket-ranges/:rangeId')
  @HttpCode(200)
  @RequirePermissions('ski_swap:admin')
  removeTicketRange(@Param('orgId') orgId: string, @Param('rangeId') rangeId: string) {
    return this.tickets.removeRange(orgId, rangeId);
  }

  @Get()
  @RequirePermissions('ski_swap:report')
  list(
    @Param('orgId') orgId: string,
    @Query('query') query?: string,
    @Query('updatedSince') updatedSince?: string,
    @Query('incomplete') incomplete?: string,
  ) {
    return this.sellerService.list(orgId, query, updatedSince, incomplete === 'true');
  }

  @Post()
  @RequirePermissions('ski_swap:manage')
  create(
    @Param('orgId') orgId: string,
    @Body() body: CreateSellerDto,
    @CurrentDevice() device: AuthenticatedDevice | undefined,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    assertScanFromDevice(body, device);
    return this.sellerService.create(orgId, body, idempotencyKey);
  }

  @Get(':sellerId')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string, @Param('sellerId') sellerId: string) {
    return this.sellerService.get(orgId, sellerId);
  }

  @Patch(':sellerId')
  @RequirePermissions('ski_swap:manage')
  patch(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Body() body: PatchSellerDto,
    @CurrentDevice() device: AuthenticatedDevice | undefined,
    // The offline queue retries, and a retried patch is a retried conflict
    // once `baseUpdatedAt` is in play: the first attempt moves the watermark,
    // so the second would be refused for having been overtaken by itself.
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    assertScanFromDevice(body, device);
    return this.sellerService.patch(orgId, sellerId, body, idempotencyKey);
  }

  @Delete(':sellerId')
  @HttpCode(204)
  @RequirePermissions('ski_swap:manage')
  async remove(@Param('orgId') orgId: string, @Param('sellerId') sellerId: string) {
    await this.sellerService.remove(orgId, sellerId);
  }

  /**
   * Staff-initiated contact verification. Issues a `verify` challenge, which
   * proves the contact without minting a session.
   */
  @Post(':sellerId/verify/:channel/initiate')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  async initiateVerification(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Param('channel') channel: string,
  ) {
    if (channel !== 'email' && channel !== 'phone') {
      throw new BadRequestException('channel must be email or phone');
    }
    const seller = await this.sellerService.findOrThrow(orgId, sellerId);
    const target = channel === 'email' ? seller.membership.user.email : seller.membership.user.phone;
    if (!target) throw new BadRequestException(`Seller has no ${channel} on record`);
    // Said at the counter, where somebody can do something about it, rather
    // than a code that silently never arrives while staff wait for it.
    if (channel === 'phone') {
      const text = await this.sms.canText(target);
      if (!text.ok) {
        throw new BadRequestException({
          message:
            text.reason === SMS_OFF
              ? 'Texting is off. Verify their email.'
              : text.reason === NOT_NORTH_AMERICAN
                ? 'We can only text US and Canadian numbers. Verify their email instead.'
                : 'Texting is paused right now. Verify their email instead.',
          code: 'CANNOT_TEXT',
        });
      }
    }

    // The challenge id goes back to staff so they can confirm an OTP the seller
    // reads out to them at the counter.
    const issued = await this.challenges.issue({
      userId: seller.membership.userId,
      channel,
      target,
      purpose: 'verify',
    });
    return { challengeId: issued.challengeId, devCode: issued.devCode };
  }

  /** Name-only cross-org lookup. The full record follows staff confirmation. */
  @Post('search')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  searchPeople(@Param('orgId') orgId: string, @Body() body: PersonSearchDto) {
    return this.sellerService.searchPeople(orgId, body);
  }

  /** Grants the seller role to a person staff have already confirmed. */
  @Post('from-person')
  @HttpCode(201)
  @RequirePermissions('ski_swap:manage')
  addFromPerson(@Param('orgId') orgId: string, @Body() body: AddSellerFromPersonDto) {
    return this.sellerService.addFromPerson(orgId, body.userId);
  }

  @Get('import/template')
  @RequirePermissions('ski_swap:manage')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="sellers-template.csv"')
  downloadTemplate(@Res() res: Response) {
    res.send('name,phone,email,street,city,state,zip\n');
  }

  @Post('import/parse')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  parseImport(@UploadedFile() file: Express.Multer.File) {
    const { headers, rows, mapping } = this.sellerService.parseImportFile(file.buffer);
    const preview = rows.slice(0, 5);
    return { headers, mapping, preview, totalRows: rows.length };
  }

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('ski_swap:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  importSellers(
    @Param('orgId') orgId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('mapping') mappingJson: string,
    @Body('duplicateStrategy') duplicateStrategy: 'overwrite' | 'preserve',
  ) {
    const mapping = JSON.parse(mappingJson) as Record<string, string>;
    return this.sellerService.importSellers(orgId, file.buffer, mapping, duplicateStrategy);
  }
}

/**
 * A Venmo code is scanned at the counter, on the staff iPad (Plan 35). A scan
 * claimed by anything else (the staff web, a script with a user's session)
 * is refused, so `payoutHandleSource: 'SCAN'` means what it says.
 */
export function assertScanFromDevice(body: { payoutHandleSource?: 'SCAN' }, device: AuthenticatedDevice | undefined): void {
  if (body.payoutHandleSource === 'SCAN' && !device) {
    throw new BadRequestException('Only the staff iPad can scan a Venmo code.');
  }
}
