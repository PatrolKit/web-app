import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../common/identity/person.service';
import { ContactChallengeService, type IssuedChallenge } from '../auth/contact-challenge.service';
import { PrintQueueService } from './print-queue.service';
import { PrintRecipeService, printTargetFor } from './printing/print-recipe.service';
import { ItemService } from './item.service';
import { ReceiptService } from './receipt.service';
import { displayName } from '../common/util/person';
import { isUniqueViolation } from '../common/util/prisma-errors';
import type { SignInContext } from '../contracts/auth.contracts';
import { NOT_NORTH_AMERICAN, SmsService } from '../sms/sms.service';

/**
 * Self-service check-in.
 *
 * A seller arrives at a station, scans its QR, proves a contact, enters their
 * own items, and walks away with a receipt. The station is the anchor: it is
 * where the tags come out, and its code namespaces every SKU printed there.
 */
@Injectable()
export class CheckinService {
  private readonly logger = new Logger(CheckinService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PersonService,
    private readonly challenges: ContactChallengeService,
    private readonly queue: PrintQueueService,
    private readonly recipes: PrintRecipeService,
    private readonly items: ItemService,
    private readonly receipts: ReceiptService,
    private readonly sms: SmsService,
  ) {}

  // ─── Public: before anyone is signed in ─────────────────────────────────────

  /**
   * What a station's QR resolves to. Deliberately thin: this is unauthenticated,
   * so it says where you are and nothing about who is here.
   */
  async context(swapId: string, stationId: string) {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, active: true },
      include: { org: true },
    });
    if (!swap) throw new NotFoundException('This swap is not currently running');

    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId: swap.orgId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!station) throw new NotFoundException('Station not found');

    return {
      orgId: swap.orgId,
      orgName: swap.org.name,
      orgLogoUrl: swap.org.logoUrl,
      swapId: swap.id,
      swapTitle: swap.title,
      stationId: station.id,
      stationName: station.name,
    };
  }

  /**
   * Registers someone who has never sold here and sends them a code.
   *
   * The person is created *unverified*: the account grants nothing until the
   * challenge is confirmed, so an unproven contact costs nothing more than a
   * row. The challenge carries the station, which is what lets an emailed link
   * land in a new tab and still know where the seller is standing.
   */
  async register(
    swapId: string,
    stationId: string,
    input: { email?: string; phone?: string },
  ): Promise<IssuedChallenge> {
    const ctx = await this.context(swapId, stationId);

    const normalized = this.people.normalize(input);
    if (!normalized.email && !normalized.phone) {
      throw new BadRequestException('An email address or phone number is required');
    }
    const channel = await this.channelFor(normalized);

    const { user } = await this.people.resolveOrCreate(input);

    return this.challenges.issue({
      userId: user.id,
      channel,
      target: (channel === 'phone' ? normalized.phone : normalized.email)!,
      purpose: 'login',
      context: { swapId: ctx.swapId, stationId: ctx.stationId } satisfies SignInContext,
    });
  }

  /**
   * One channel, chosen here: phone leads, because an SMS code offers itself in
   * the iOS keyboard bar and an emailed link does not.
   *
   * But only a number we can text (Plan 26 §7): a US or Canadian one, while
   * texting is not paused. Otherwise email, when there is one; and when there
   * is not, a refusal that says what to do, rather than a code that never
   * arrives.
   */
  private async channelFor(contact: { email?: string | null; phone?: string | null }): Promise<'phone' | 'email'> {
    if (!contact.phone) return 'email';
    const text = await this.sms.canText(contact.phone);
    if (text.ok) return 'phone';
    if (contact.email) return 'email';
    throw new BadRequestException({
      message:
        text.reason === NOT_NORTH_AMERICAN
          ? 'We can only text US and Canadian numbers. Use an email address instead.'
          : 'We cannot send texts right now. Use an email address instead.',
      code: 'CANNOT_TEXT',
    });
  }

  // ─── Authenticated: joining and finishing ───────────────────────────────────

  /**
   * Puts a signed-in person on the org roster with an individual seller profile.
   *
   * Idempotent, and it has to be: a seller who reloads mid-check-in hits this
   * again, and the profile carries every item they have entered.
   */
  /**
   * This seller's profile, created the first time they check in.
   *
   * Two joins racing each other is the ordinary case, not a rare one: a station
   * QR opened twice, a reload, or a seller double-tapping the link all land two
   * of these at once, and `upsert` is not atomic enough to survive it (see
   * `isUniqueViolation`). Losing the race means the profile exists, which is
   * what the call was for — so read it back instead of failing a check-in.
   */
  private async claimSellerProfile(membershipId: string): Promise<{ id: string }> {
    try {
      return await this.prisma.sellerProfile.upsert({
        where: { membershipId },
        update: { deletedAt: null },
        // No businessName: check-in creates individuals. A business seller is set
        // up by staff, and already has a profile before they get here.
        create: { id: createId(), membershipId },
        select: { id: true },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // The winner has committed by the time the loser's insert is rejected, so
      // this reads a row rather than racing for it again.
      return this.prisma.sellerProfile.update({
        where: { membershipId },
        data: { deletedAt: null },
        select: { id: true },
      });
    }
  }

  async join(userId: string, swapId: string, stationId: string) {
    const ctx = await this.context(swapId, stationId);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        firstName: true, lastName: true,
        street: true, city: true, state: true, zip: true,
        payoutMethod: true, payoutTarget: true, payoutHandle: true,
        verifiedEmail: true, verifiedPhone: true,
      },
    });

    const membership = await this.people.upsertMembership(userId, ctx.orgId);
    const seller = await this.claimSellerProfile(membership.id);

    return {
      ...ctx,
      sellerId: seller.id,
      /**
       * Nothing to print on a receipt but a phone number. Asked once, here,
       * rather than up front where it would be discarded for everyone already
       * on the roster.
       */
      needsName: !user.firstName && !user.lastName,

      /**
       * What the address and payout steps start from. Sent with the join rather
       * than fetched separately: both steps run back to back on venue wifi,
       * with someone waiting, and neither has anything to show until it arrives.
       *
       * The verified contacts travel as values because the payout step both
       * offers them as destinations and displays which one the money goes to.
       */
      profile: {
        street: user.street,
        city: user.city,
        state: user.state,
        zip: user.zip,
        payoutMethod: user.payoutMethod,
        payoutTarget: user.payoutTarget,
        payoutHandle: user.payoutHandle,
        verifiedEmail: user.verifiedEmail,
        verifiedPhone: user.verifiedPhone,
      },
    };
  }

  /**
   * Ends a check-in: prints the receipt, then pushes the batch to Square.
   *
   * Square comes last and off the item-save path. Each save would otherwise
   * carry two Square round-trips on venue wifi, inside an interaction the seller
   * is watching. Doing it here costs nothing they can see — and an item that is
   * not on the floor yet cannot be sold at the register anyway.
   */
  async finish(orgId: string, userId: string, swapId: string, stationId: string) {
    const station = await this.prisma.checkinStation.findFirst({
      where: { id: stationId, orgId, deletedAt: null },
      include: { bridge: { include: { bridgedPrinter: true } } },
    });
    if (!station) throw new NotFoundException('Station not found');

    const seller = await this.prisma.sellerProfile.findFirst({
      where: { deletedAt: null, membership: { orgId, userId, deletedAt: null } },
      select: { id: true },
    });
    if (!seller) throw new NotFoundException('You are not checked in at this swap');

    // The last moment anything can be asked of someone about to walk away.
    //
    // Completeness is checked here rather than on every write, so staff can go
    // on correcting one field at a time on a record that is still missing
    // others — a seller finishing a check-in is the only case where everything
    // has to be there at once.
    const person = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!person.street || !person.city || !person.state || !person.zip) {
      throw new BadRequestException('We still need your address before you can finish.');
    }
    if (!person.payoutMethod) {
      throw new BadRequestException('We still need to know how to pay you before you can finish.');
    }
    if (
      (person.payoutMethod === 'PAYPAL' || person.payoutMethod === 'VENMO') &&
      !person.payoutTarget
    ) {
      throw new BadRequestException('We still need to know where to send your money.');
    }


    const items = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId: seller.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    // Header plus one job per page of the item list. Page count comes from the
    // renderer rather than a guess about how many fit.
    const target = printTargetFor(station.bridge?.bridgedPrinter ?? null);
    const pageCount = await this.recipes.receiptPageCount(orgId, swapId, seller.id, target);
    await this.queue.enqueueReceipt({
      orgId, stationId: station.id, swapId, sellerId: seller.id, pageCount,
      // The tall tier's page one carries the masthead itself.
      withHeader: target.size.tier !== 'tall',
    });

    /*
     * The record, frozen here because here is where it is true. The seller is
     * standing at the counter with the items they just described, and every
     * later edit makes this moment harder to reconstruct.
     *
     * Best-effort, like the email and the Square push below and for the same
     * reason: a seller who has done everything right must not be held at the
     * counter because a row could not be written. The sellers list can mint one
     * on demand.
     */
    // `currentFor` rather than `snapshot`: finishing has no guard against being
    // called twice, and minting unconditionally gave a seller who double-tapped
    // Done two receipts for one pile of items — two live tokens, and only one
    // of them revoked if anybody ever revoked it.
    await this.receipts.currentFor(orgId, swapId, seller.id, station.id).catch((err) => {
      this.logger.error({ err, swapId, sellerId: seller.id }, 'Could not snapshot the receipt');
    });

    /*
     * And emailed, wherever there is a proved address to email.
     *
     * It used to need a button. Everybody pressed it, and the ones who did not
     * were the ones who walked away with only the paper — which is the copy
     * most likely to be lost, and the only one carrying the link they need in
     * three weeks to find out what sold.
     *
     * Email only. A text is a link rather than the receipt itself and costs
     * money per message, so it stays behind the button on the finish screen
     * for sellers who have no email.
     */
    const emailedTo = person.verifiedEmail
      ? await this.receipts
          .send({
            orgId,
            swapId,
            sellerId: seller.id,
            channel: 'EMAIL',
            actorUserId: userId,
            /*
             * Keyed on what is being sent, not on the attempt.
             *
             * `finish` has no guard against being called twice — a double tap,
             * or a retry after a dropped response — and each call snapshots a
             * fresh receipt, so keying on the receipt id would let a double tap
             * through as two emails. The item count and total are the same for
             * a repeat and different for a seller who came back with more, so
             * they dedupe the first and let the second through.
             */
            idempotencyKey: `checkin-finish:${swapId}:${seller.id}:${items.length}:${items.reduce((sum, i) => sum + i.priceCents, 0)}`,
          })
          // Only a real send. `SUPPRESSED` is a deployment with outbound
          // messaging off, and reporting it as sent would leave the finish
          // screen promising an email that is never coming.
          .then((res) => (res.status === 'SENT' ? res.destination : null))
          .catch((err: unknown) => {
            this.logger.error({ err, swapId, sellerId: seller.id }, 'Could not email the receipt');
            return null;
          })
      : null;

    /**
     * Only what has been accepted. An item still waiting for a staff member to
     * look at it must not be sellable, and the way to guarantee that is for it
     * not to be in the catalogue at all — its push happens when it is
     * consigned, not here.
     *
     * With the org toggle off every item is consigned at creation, so this is
     * the whole batch and nothing changes.
     */
    const consigned = items.filter((i) => i.consignedAt !== null);
    const awaiting = items.length - consigned.length;

    // Deliberately after the receipt is queued: a Square outage must not hold a
    // seller at the counter with no paperwork.
    const failed = await this.pushToSquare(orgId, swapId, consigned.map((i) => i.id));

    return {
      itemCount: items.length,
      // Labels queued, which is the item pages plus a masthead only where the
      // tier prints one. The tall tier folds its masthead into page one, so
      // `+ 1` there reported a label nobody enqueued.
      receiptPages: pageCount + (target.size.tier !== 'tall' ? 1 : 0),
      /**
       * Reported, not thrown. The items exist and their tags are printed; staff
       * can re-push from the items table, and failing the finish would strand a
       * seller who has done everything right.
       */
      squareFailures: failed,
      /**
       * How many of them still need a staff member to look at them. Zero for
       * an org that has not turned the scan on, which is what lets the finish
       * screen decide what to say without knowing about the setting.
       */
      awaitingConsignment: awaiting,
      /**
       * Where the receipt was emailed, or null if it was not.
       *
       * Null covers three different things — no verified email, messaging off,
       * a provider that refused — and the finish screen treats them alike: it
       * offers the button instead. Claiming an email that did not go is the one
       * outcome worth avoiding, and that is the only distinction it needs.
       */
      emailedTo,
    };
  }

  private async pushToSquare(orgId: string, swapId: string, itemIds: string[]): Promise<number> {
    let failed = 0;
    for (const itemId of itemIds) {
      const result = await this.items
        .syncToPos(orgId, swapId, itemId)
        .catch((err: unknown) => {
          this.logger.error({ err, itemId }, 'Square push threw during check-in finish');
          return 'failed' as const;
        });
      if (result === 'failed') failed++;
    }
    return failed;
  }

  // ─── Summary ────────────────────────────────────────────────────────────────

  /** Everything the finish screen shows: who, what, and how much. */
  async summary(orgId: string, userId: string, swapId: string) {
    const seller = await this.prisma.sellerProfile.findFirst({
      where: { deletedAt: null, membership: { orgId, userId, deletedAt: null } },
      include: { membership: { include: { user: true } } },
    });
    if (!seller) throw new NotFoundException('You are not checked in at this swap');

    const items = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId: seller.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, sku: true, priceCents: true, hasPrintedTag: true },
    });

    return {
      sellerId: seller.id,
      sellerName: displayName(seller.membership.user, seller.businessName),
      items,
      totalCents: items.reduce((sum, i) => sum + i.priceCents, 0),
    };
  }
}
