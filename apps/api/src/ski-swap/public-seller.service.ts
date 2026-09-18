import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  PublicSellerDetailResponse,
  PublicSellerPayout,
} from '../contracts/ski-swap.contracts';
import { displayName } from '../common/util/person';
import { basisPointsToPercent } from './payouts/money';

@Injectable()
export class PublicSellerService {
  constructor(private readonly prisma: PrismaService) {}

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
    };

    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: seller.orgId, moduleKey: 'ski_swap' } },
    });
    if (!orgModule?.enabled) throw new NotFoundException('Seller not found');

    const activeSwaps = await this.prisma.skiSwap.findMany({
      where: { orgId: seller.orgId, active: true },
    });
    // Read before the early return: a seller whose swap has ended still has
    // money to account for, and that is exactly when they come looking.
    const { payouts, soldItemIds } = await this.payoutsFor(seller.id);

    if (!activeSwaps.length) {
      return {
        sellerName: seller.name,
        orgName: seller.org.name,
        orgLogoUrl: seller.org.logoUrl ?? null,
        swaps: [],
        payouts,
      };
    }

    const activeSwapIds = activeSwaps.map((s) => s.id);
    const items = await this.prisma.swapItem.findMany({
      where: { sellerId: seller.id, swapId: { in: activeSwapIds } },
      select: {
        id: true,
        swapId: true,
        name: true,
        sku: true,
        priceCents: true,
        originalQuantity: true,
        donateProceeds: true,
        consignedAt: true,
      },
    });

    // Group items by swap, omitting swaps with no items for this seller
    const swapMap = new Map<string, { swapId: string; swapTitle: string; items: typeof items }>();
    for (const item of items) {
      if (!swapMap.has(item.swapId)) {
        const swap = activeSwaps.find((s) => s.id === item.swapId)!;
        swapMap.set(item.swapId, { swapId: swap.id, swapTitle: swap.title, items: [] });
      }
      swapMap.get(item.swapId)!.items.push(item);
    }

    return {
      sellerName: seller.name,
      orgName: seller.org.name,
      orgLogoUrl: seller.org.logoUrl ?? null,
      payouts,
      swaps: Array.from(swapMap.values()).map((s) => ({
        swapId: s.swapId,
        swapTitle: s.swapTitle,
        items: s.items.map((item) => ({
          itemId: item.id,
          name: item.name,
          sku: item.sku,
          priceCents: item.priceCents,
          originalQuantity: item.originalQuantity,
          // DB-only: inStock is not yet decremented by Square; treat originalQty as inStock
          inStock: soldItemIds.has(item.id) ? 0 : item.originalQuantity,
          // Square's inventory is not mirrored here, so this was always zero —
          // which was merely incomplete until a payout section appeared
          // underneath it, and then became a contradiction: "Not yet sold"
          // directly above "Sold $100.00, paid". A payout line is proof of a
          // sale, so where one exists it is believed.
          soldCount: soldItemIds.has(item.id) ? 1 : 0,
          donateProceeds: item.donateProceeds,
          // A date rather than the date: the seller is told whether their item
          // was taken, not when a volunteer got to it.
          consigned: item.consignedAt !== null,
        })),
      })),
    };
  }

  /**
   * This seller's payouts, across every swap (Plan 25 §8).
   *
   * Not filtered to active swaps. A payout outlives the swap that caused it,
   * and a seller chasing money from a swap that closed last month is precisely
   * the person this section is for.
   */
  private async payoutsFor(
    sellerId: string,
  ): Promise<{ payouts: PublicSellerPayout[]; soldItemIds: Set<string> }> {
    const lines = await this.prisma.payoutLine.findMany({
      where: { sellerId },
      orderBy: { createdAt: 'desc' },
      include: {
        items: { select: { itemId: true } },
        run: { select: { commissionBasisPoints: true, swap: { select: { title: true } } } },
      },
    });

    // Which of this seller's items a run found a sale for. The payout's own
    // evidence, so the two halves of the page cannot disagree.
    const soldItemIds = new Set<string>();
    for (const line of lines) {
      for (const item of line.items) if (item.itemId) soldItemIds.add(item.itemId);
    }

    const payouts = lines.map((line) => ({
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

    return { payouts, soldItemIds };
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
