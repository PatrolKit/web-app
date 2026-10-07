import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PublicSellerDetailResponse,
  PublicSellerPayout,
} from '../contracts/ski-swap.contracts';
import { displayName } from '../common/util/person';
import { basisPointsToPercent } from './payouts/money';
import { PosAdapterFactory } from './pos/pos.adapter';

@Injectable()
export class PublicSellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
  ) {}

  async getById(sellerId: string): Promise<PublicSellerDetailResponse> {
    const profile = await this.prisma.sellerProfile.findUnique({
      where: { id: sellerId },
      include: { membership: { include: { user: true, org: true } } },
    });
    if (!profile || profile.deletedAt || profile.membership.deletedAt) {
      throw new NotFoundException('Seller not found');
    }
    const seller = {
      id: profile.id,
      orgId: profile.membership.orgId,
      name: displayName(profile.membership.user, profile.businessName),
      org: profile.membership.org,
      payoutMethod: (profile.membership.user.payoutMethod ??
        null) as PublicSellerDetailResponse['payoutMethod'],
    };

    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: seller.orgId, moduleKey: 'ski_swap' } },
    });
    if (!orgModule?.enabled) throw new NotFoundException('Seller not found');

    // Only swaps with Unauthenticated Seller Status on (Plan 33): this page
    // needs no sign-in, so each swap decides whether it's shown here.
    const activeSwaps = await this.prisma.skiSwap.findMany({
      where: { orgId: seller.orgId, active: true, sellerLookupEnabled: true },
    });
    // Read before the early return: a seller whose swap has ended still has
    // money to account for, and that is exactly when they come looking.
    const payouts = await this.payoutsFor(seller.id);

    const hasOpenItems = activeSwaps.length > 0 && (await this.prisma.swapItem.count({
      where: { sellerId: seller.id, swapId: { in: activeSwaps.map((s) => s.id) }, deletedAt: null },
    })) > 0;
    if (!hasOpenItems && !payouts.length) {
      // Says nothing about the seller, not even that there is one here.
      return {
        available: false,
        sellerName: null,
        orgName: seller.org.name,
        orgLogoUrl: seller.org.logoUrl ?? null,
        payoutMethod: null,
        swaps: [],
        payouts: [],
      };
    }

    if (!activeSwaps.length) {
      return {
        available: true,
        sellerName: seller.name,
        orgName: seller.org.name,
        orgLogoUrl: seller.org.logoUrl ?? null,
        payoutMethod: seller.payoutMethod,
        swaps: [],
        payouts,
      };
    }

    const activeSwapIds = activeSwaps.map((s) => s.id);
    const items = await this.prisma.swapItem.findMany({
      where: { sellerId: seller.id, swapId: { in: activeSwapIds }, deletedAt: null },
      select: {
        id: true,
        swapId: true,
        name: true,
        sku: true,
        priceCents: true,
        originalQuantity: true,
        donateProceeds: true,
        consignedAt: true,
        squareVariationId: true,
        returnedAt: true,
        returnedUnits: true,
      },
    });

    // Group items by swap, omitting swaps with no items for this seller
    const swapMap = new Map<string, { swapId: string; swapTitle: string; locationId: string; items: typeof items }>();
    for (const item of items) {
      if (!swapMap.has(item.swapId)) {
        const swap = activeSwaps.find((s) => s.id === item.swapId)!;
        swapMap.set(item.swapId, { swapId: swap.id, swapTitle: swap.title, locationId: swap.locationId, items: [] });
      }
      swapMap.get(item.swapId)!.items.push(item);
    }

    /*
     * Sold means Square says so, the same reading the staff items page takes.
     *
     * This used to be derived from payout lines, which exist only once a
     * payout run has been built — days after the swap — so a seller opening
     * the link on their receipt saw "Not yet sold" under every item all
     * weekend, beneath a sentence promising the page updates on its own. A
     * payout is what the seller is paid; it is not where a sale is recorded,
     * and it says nothing about anything until somebody builds one.
     *
     * One Square read per swap, because the location is the swap's. A read
     * that fails leaves those items "unknown" rather than unsold: the page
     * says it could not check, which is true, instead of guessing.
     */
    const pos = await this.posFactory.forOrg(seller.orgId);
    const swaps = await Promise.all(
      Array.from(swapMap.values()).map(async (s) => {
        const variationIds = s.items
          .map((i) => i.squareVariationId)
          .filter((id): id is string => !!id);
        const counts: Map<string, number> | null =
          pos && s.locationId && variationIds.length
            ? await pos.getInventoryCounts(variationIds, s.locationId).catch(() => null)
            : new Map();

        return {
          swapId: s.swapId,
          swapTitle: s.swapTitle,
          items: s.items.map((item) => {
            // Handed back (Plan 43): out of Square, so its count there says
            // nothing. What didn't go home sold; the rest went back.
            if (item.returnedAt) {
              const back = item.returnedUnits ?? item.originalQuantity;
              return {
                itemId: item.id, name: item.name, sku: item.sku, priceCents: item.priceCents,
                originalQuantity: item.originalQuantity, inStock: 0,
                soldCount: Math.max(0, item.originalQuantity - back), inventoryKnown: true,
                donateProceeds: item.donateProceeds, consigned: true, returnedAt: item.returnedAt.toISOString(),
              };
            }
            // Only an item in Square has stock to not know about. Anything
            // not there yet has all of its stock, by our own record.
            const inventoryKnown = counts !== null || !item.squareVariationId;
            const inStock = !inventoryKnown
              ? item.originalQuantity
              : item.squareVariationId
                ? (counts!.get(item.squareVariationId) ?? 0)
                : item.originalQuantity;
            return {
              itemId: item.id,
              name: item.name,
              sku: item.sku,
              priceCents: item.priceCents,
              originalQuantity: item.originalQuantity,
              inStock,
              soldCount: Math.max(0, item.originalQuantity - inStock),
              inventoryKnown,
              donateProceeds: item.donateProceeds,
              // A date rather than the date: the seller is told whether their item
              // was taken, not when a volunteer got to it.
              consigned: item.consignedAt !== null,
              returnedAt: null,
            };
          }),
        };
      }),
    );

    return {
      available: true,
      sellerName: seller.name,
      orgName: seller.org.name,
      orgLogoUrl: seller.org.logoUrl ?? null,
      payoutMethod: seller.payoutMethod,
      payouts,
      swaps,
    };
  }

  /**
   * This seller's payouts, across every swap (Plan 25 §8).
   *
   * Not filtered to active swaps. A payout outlives the swap that caused it,
   * and a seller chasing money from a swap that closed last month is precisely
   * the person this section is for.
   */
  private async payoutsFor(sellerId: string): Promise<PublicSellerPayout[]> {
    const lines = await this.prisma.payoutLine.findMany({
      // Swaps with Unauthenticated Seller Status on only, active or not (Plan 33).
      where: { sellerId, run: { swap: { sellerLookupEnabled: true } } },
      orderBy: { createdAt: 'desc' },
      include: {
        run: { select: { commissionBasisPoints: true, swap: { select: { title: true } } } },
      },
    });

    return lines.map((line) => ({
      swapTitle: line.run.swap.title,
      status: line.status as PublicSellerPayout['status'],
      grossCents: line.grossCents,
      commissionCents: line.commissionCents,
      netCents: line.netCents,
      commissionPercent: basisPointsToPercent(line.run.commissionBasisPoints),
      method: line.method as PublicSellerPayout['method'],
      destination: maskDestination(line.destination, line.destinationType),
      sentAt: line.sentAt?.toISOString() ?? null,
      checkSentAt: line.checkSentAt?.toISOString() ?? null,
      // UNCLAIMED is the only state where the seller, rather than the patrol,
      // is the person who can do something about it.
      needsAction: line.status === 'UNCLAIMED',
    }));
  }
}

/**
 * Enough of a destination to recognise, not enough to use.
 *
 * `/s/:sellerId` needs no sign-in — it is on the receipt and the tag — so the
 * page is as public as whoever holds the link. A seller asking "is that my old
 * email?" can answer from the first letter and the domain; a stranger learns
 * nothing they could contact anybody at.
 */
export function maskDestination(destination: string | null, type: string | null): string | null {
  if (!destination) return null;

  if (type === 'EMAIL') {
    const [name = '', domain = ''] = destination.split('@');
    return `${name.slice(0, 1)}${'\u2022'.repeat(Math.max(3, name.length - 1))}@${domain}`;
  }
  if (type === 'PHONE') {
    return `(\u2022\u2022\u2022) \u2022\u2022\u2022-${destination.slice(-4)}`;
  }
  // A PayPal or Venmo handle the seller typed themselves. Shown by its first
  // two characters, for the same reason.
  return `${destination.slice(0, 2)}${'\u2022'.repeat(Math.max(3, destination.length - 2))}`;
}
