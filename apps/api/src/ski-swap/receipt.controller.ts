import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard, type AuthenticatedUser } from '../common/guards/jwt-auth.guard';
import { OrDeviceAuthGuard } from '../common/guards/or-device-auth.guard';
import { RequireDeviceRole } from '../common/decorators/require-device-role.decorator';
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
 * Receipts, from the staff side.
 *
 * Reachable by a person with `ski_swap:manage`, and — on the two routes that
 * carry `@RequireDeviceRole` — by a check-in iPad, which has no user token and
 * never will: it authenticates with provisioning credentials and there is no
 * sign-in anywhere in that app.
 *
 * The role is named per route, never on the class. `PermissionsGuard` resolves
 * `@RequireDeviceRole` with `getAllAndOverride([handler, class])`, so a
 * class-level annotation would open every route in here to every device that
 * matched — which is the trap, rather than device access itself. Per route the
 * set is exactly the check-in stations, which already create the sellers and
 * items a receipt is a snapshot of. `list` and `revoke` name no role and so
 * refuse device tokens outright, which is the guard's default.
 */
@Controller('orgs/:orgId/ski-swap')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
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
  @RequireDeviceRole('ski_swap.staff_check_in')
  create(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Body() body: CreateReceiptDto,
  ) {
    return this.receipts.createFor(orgId, body.swapId, sellerId, body.stationId ?? null);
  }

  @Post('sellers/:sellerId/receipts/send')
  @RequirePermissions('ski_swap:manage')
  @RequireDeviceRole('ski_swap.staff_check_in')
  send(
    @Param('orgId') orgId: string,
    @Param('sellerId') sellerId: string,
    @Body() body: SendReceiptDto,
    // Undefined for a device: a station has no person behind it, and the
    // delivery row records that as nobody rather than inventing an actor.
    @CurrentUser() user: AuthenticatedUser | undefined,
    // A send is the one write here that is not naturally idempotent — it puts
    // a message in a member of the public's inbox. A client that queues sends
    // for an offline counter retries them, and a retry must not be a second
    // email. See `ReceiptService.send`.
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.receipts.send({
      orgId,
      swapId: body.swapId,
      sellerId,
      // Optional, and the counter's reason for existing: an iPad offering
      // Print / Email / Text needs Text to send a text. Omitted — which is what
      // the web sends — the server resolves it as it always has.
      channel: body.channel ?? null,
      actorUserId: user?.userId ?? null,
      idempotencyKey,
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
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.receipts.send({
      orgId,
      swapId: body.swapId,
      sellerId: seller.id,
      // Honoured here too rather than silently dropped: the body schema is
      // shared, and a seller choosing between their own two verified contacts
      // reaches nothing the default would not have.
      channel: body.channel ?? null,
      // Nobody pressed it on their behalf.
      actorUserId: null,
      idempotencyKey,
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
