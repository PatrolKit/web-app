import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard, type AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { OrgContextGuard } from '../common/guards/org-context.guard';
import { ModuleEnabledGuard } from '../common/guards/module-enabled.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { SellerProfileGuard, type CallerSellerProfile } from '../common/guards/seller-profile.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RequireModule } from '../common/decorators/require-module.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentSeller } from '../common/decorators/current-seller.decorator';
import { ReceiptService } from './receipt.service';
import { CreateReceiptDto, SendReceiptDto } from '../contracts/receipt.contracts';

/**
 * Sending a receipt, from the staff side.
 *
 * Guarded by permissions, and deliberately not by `OrDeviceAuthGuard` the way
 * the sellers controller is. `PermissionsGuard` checks a *device* against its
 * role instead of against permission keys, so anything reachable by a device
 * is reachable by every provisioned device — and a scanner has no business
 * emailing a seller.
 */
@Controller('orgs/:orgId/ski-swap')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class ReceiptController {
  constructor(private readonly receipts: ReceiptService) {}

  /**
   * Creates the record without sending anything.
   *
   * For iOS, which prints receipts itself: the printer is one rendering of a
   * receipt, not the thing itself, so the iPad creates the record here and
   * prints from what comes back. Without this an iOS check-in leaves a seller
   * holding paper the server has never heard of, and a later Send mints a fresh
   * snapshot of whatever the items look like by then.
   *
   * Safe to retry — see `currentFor`: the same items give back the same receipt
   * rather than a second one.
   */
  @Post('sellers/:sellerId/receipts')
  @RequirePermissions('ski_swap:manage')
  create(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Body() body: CreateReceiptDto,
  ) {
    return this.receipts.createFor(orgId, body.swapId, sellerId, body.stationId ?? null);
  }

  @Post('sellers/:sellerId/receipts/send')
  @RequirePermissions('ski_swap:manage')
  send(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Body() body: SendReceiptDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.receipts.send({
      orgId,
      swapId: body.swapId,
      sellerId,
      actorUserId: user.userId,
    });
  }

  @Get('sellers/:sellerId/receipts')
  @RequirePermissions('ski_swap:manage')
  list(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Query('swapId') swapId: string,
  ) {
    return this.receipts.listForSeller(orgId, swapId, sellerId);
  }

  @Post('receipts/:receiptId/revoke')
  @RequirePermissions('ski_swap:manage')
  async revoke(@Param('orgId') orgId: string, @Param('receiptId') receiptId: string) {
    await this.receipts.revoke(orgId, receiptId);
    return { revoked: true };
  }
}

/**
 * A seller asking for their own copy.
 *
 * Throttled where the staff route is not: this one is reachable by anyone who
 * can sign in as a seller, and every press costs an email or a text. The seller
 * comes from the guard, never from the path — there is no id here to get wrong.
 */
@Controller('orgs/:orgId/ski-swap/seller/me')
@UseGuards(JwtAuthGuard, OrgContextGuard, ModuleEnabledGuard, SellerProfileGuard)
@RequireModule('ski_swap')
export class SellerReceiptController {
  constructor(private readonly receipts: ReceiptService) {}

  @Post('receipts/send')
  @Throttle({ default: { ttl: 3_600_000, limit: 3 } })
  send(
    @Param('orgId') orgId: string,
    @Body() body: SendReceiptDto,
    @CurrentSeller() seller: CallerSellerProfile,
  ) {
    return this.receipts.send({
      orgId,
      swapId: body.swapId,
      sellerId: seller.id,
      // Nobody pressed it on their behalf.
      actorUserId: null,
    });
  }
}

/**
 * The public page's data: an unguessable token in, a frozen receipt out.
 *
 * No auth by design — the token is the credential. Throttled like the other
 * public reads, because an unauthenticated route with a lookup behind it is
 * worth rate-limiting whether or not the token is guessable.
 */
@Controller('public/receipts')
@Throttle({ default: { ttl: 60_000, limit: 20 } })
export class PublicReceiptController {
  constructor(private readonly receipts: ReceiptService) {}

  @Get(':token')
  get(@Param('token') token: string) {
    return this.receipts.byToken(token);
  }
}
