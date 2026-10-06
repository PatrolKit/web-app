import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { checkinsPerDay, type CheckinDay } from './checkins-per-day';

/**
 * The dashboard's figures, from our own rows only (Plan 39 D6). Sales live in
 * Square's reports; nothing here reads Square.
 */
export interface SwapStats {
  totalItems: number;
  /** Sellers with an item in this swap. */
  totalSellers: number;
  /** Of those, how many had an item in an earlier swap of this org. */
  returningSellers: number;
  /** The rest: this is the first swap they've sold in here. */
  newSellers: number;
  /** Tickets checked in without a price and still without one (Plan 32). */
  unpricedItems: number;
  /**
   * What staff have accepted for sale, at listed prices: priced, consigned
   * items. Moves during check-in, before anything has sold.
   */
  consignedValueCents: number;
  /** Consigned items, priced or not. */
  consignedItems: number;
  /** Consigned items still without a price, so not in `consignedValueCents`. */
  consignedUnpriced: number;
}

@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async getSwapStats(orgId: string, swapId: string): Promise<SwapStats> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');

    const [totalItems, totalSellers, consigned, unpricedItems] = await this.prisma.$transaction([
      this.prisma.swapItem.count({ where: { swapId, orgId, deletedAt: null } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId, sellerId: { not: null }, deletedAt: null }, distinct: ['sellerId'], select: { sellerId: true } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId, deletedAt: null, consignedAt: { not: null } }, select: { originalQuantity: true, priceCents: true } }),
      this.prisma.swapItem.count({ where: { swapId, orgId, deletedAt: null, priceCents: null } }),
    ]);

    // Returning: an item of theirs in a swap that started before this one.
    // Only swaps run in PatrolKit count, so a first PatrolKit swap reads all new.
    const sellerIds = totalSellers.map((s) => s.sellerId!).filter(Boolean);
    const returning = sellerIds.length
      ? await this.prisma.swapItem.findMany({
          where: { orgId, sellerId: { in: sellerIds }, deletedAt: null, swap: { createdAt: { lt: swap.createdAt } } },
          distinct: ['sellerId'],
          select: { sellerId: true },
        })
      : [];

    return {
      totalItems,
      totalSellers: totalSellers.length,
      returningSellers: returning.length,
      newSellers: totalSellers.length - returning.length,
      unpricedItems,
      consignedItems: consigned.length,
      consignedUnpriced: consigned.filter((i) => i.priceCents === null).length,
      consignedValueCents: consigned.reduce((sum, i) => sum + (i.priceCents ?? 0) * i.originalQuantity, 0),
    };
  }

  /**
   * Items checked in per day, individuals and businesses apart, in the swap's
   * time zone (see `checkinsPerDay`). An item with no seller counts as an
   * individual's.
   */
  async getCheckinsPerDay(orgId: string, swapId: string): Promise<{ timeZone: string; days: CheckinDay[] }> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { timeZone: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const items = await this.prisma.swapItem.findMany({
      where: { swapId, orgId, deletedAt: null },
      select: { createdAt: true, seller: { select: { businessName: true } } },
    });
    return {
      timeZone: swap.timeZone,
      days: checkinsPerDay(items.map((i) => ({ createdAt: i.createdAt, business: !!i.seller?.businessName })), swap.timeZone),
    };
  }
}
