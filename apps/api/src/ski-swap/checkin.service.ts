import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createId } from '@paralleldrive/cuid2';
import { PrismaService } from '../prisma/prisma.service';
import { PersonService } from '../common/identity/person.service';
import { ContactChallengeService, type IssuedChallenge } from '../auth/contact-challenge.service';
import { PrintQueueService } from './print-queue.service';
import { PrintRecipeService, printTargetFor } from './printing/print-recipe.service';
import { ItemService } from './item.service';
import { displayName } from '../common/util/person';
import type { SignInContext } from '../contracts/auth.contracts';

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
    input: { firstName?: string; lastName?: string; email?: string; phone?: string },
  ): Promise<IssuedChallenge> {
    const ctx = await this.context(swapId, stationId);

    const normalized = this.people.normalize(input);
    if (!normalized.email && !normalized.phone) {
      throw new BadRequestException('An email address or mobile number is required');
    }
    // One channel, chosen here: phone leads, because an SMS code offers itself
    // in the iOS keyboard bar and an emailed link does not.
    const channel = normalized.phone ? 'phone' : 'email';

    const { user } = await this.people.resolveOrCreate(input);

    return this.challenges.issue({
      userId: user.id,
      channel,
      target: (channel === 'phone' ? normalized.phone : normalized.email)!,
      purpose: 'login',
      context: { swapId: ctx.swapId, stationId: ctx.stationId } satisfies SignInContext,
    });
  }

  // ─── Authenticated: joining and finishing ───────────────────────────────────

  /**
   * Puts a signed-in person on the org roster with an individual seller profile.
   *
   * Idempotent, and it has to be: a seller who reloads mid-check-in hits this
   * again, and the profile carries every item they have entered.
   */
  async join(userId: string, swapId: string, stationId: string) {
    const ctx = await this.context(swapId, stationId);

    const membership = await this.people.upsertMembership(userId, ctx.orgId);
    const seller = await this.prisma.sellerProfile.upsert({
      where: { membershipId: membership.id },
      update: { deletedAt: null },
      // No businessName: check-in creates individuals. A business seller is set
      // up by staff, and already has a profile before they get here.
      create: { id: createId(), membershipId: membership.id },
      select: { id: true },
    });

    return { ...ctx, sellerId: seller.id };
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
      include: { printer: true },
    });
    if (!station) throw new NotFoundException('Station not found');

    const seller = await this.prisma.sellerProfile.findFirst({
      where: { deletedAt: null, membership: { orgId, userId, deletedAt: null } },
      select: { id: true },
    });
    if (!seller) throw new NotFoundException('You are not checked in at this swap');

    const items = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId: seller.id },
      orderBy: { createdAt: 'asc' },
    });

    // Header plus one job per page of the item list. Page count comes from the
    // renderer rather than a guess about how many fit.
    const pageCount = await this.recipes.receiptPageCount(
      orgId, swapId, seller.id, printTargetFor(station.printer),
    );
    await this.queue.enqueueReceipt({ orgId, stationId: station.id, swapId, sellerId: seller.id, pageCount });

    // Deliberately after the receipt is queued: a Square outage must not hold a
    // seller at the counter with no paperwork.
    const failed = await this.pushToSquare(orgId, swapId, items.map((i) => i.id));

    return {
      itemCount: items.length,
      receiptPages: pageCount + 1,
      /**
       * Reported, not thrown. The items exist and their tags are printed; staff
       * can re-push from the items table, and failing the finish would strand a
       * seller who has done everything right.
       */
      squareFailures: failed,
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
      where: { orgId, swapId, sellerId: seller.id },
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
