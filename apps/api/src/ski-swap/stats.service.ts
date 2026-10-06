import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { checkinsHeatmap, type CheckinsHeatmap } from './checkins-per-day';

/**
 * The dashboard's figures, from our own rows only (Plan 39 D6). Sales live in
 * Square's reports; nothing here reads Square.
 */
export interface SwapStats {
  totalItems: number;
  /** Sellers with an item in this swap. */
  totalSellers: number;
  /** Of those, how many were sellers before this swap's first check-in. */
  returningSellers: number;
  /** The rest: became sellers at or after the first check-in. */
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

    // Returning: a seller already on the books before this swap's first
    // check-in (an item still in it). Earlier years needn't be in PatrolKit:
    // a seller imported or set up ahead of the swap counts.
    const sellerIds = totalSellers.map((s) => s.sellerId!).filter(Boolean);
    const first = sellerIds.length
      ? await this.prisma.swapItem.findFirst({
          where: { swapId, orgId, deletedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        })
      : null;
    const returning = first
      ? await this.prisma.sellerProfile.findMany({
          where: { id: { in: sellerIds }, createdAt: { lt: first.createdAt } },
          select: { id: true },
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
   * Item check-ins by day and hour, in the swap's time zone, for the heat map
   * (see `checkinsHeatmap`). An item with no seller counts as an individual's.
   */
  async getCheckinsHeatmap(orgId: string, swapId: string): Promise<CheckinsHeatmap & { timeZone: string }> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { timeZone: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const items = await this.prisma.swapItem.findMany({
      where: { swapId, orgId, deletedAt: null },
      select: { createdAt: true, sellerId: true, seller: { select: { businessName: true } } },
    });
    return {
      timeZone: swap.timeZone,
      ...checkinsHeatmap(items.map((i) => ({ createdAt: i.createdAt, sellerId: i.sellerId, business: !!i.seller?.businessName })), swap.timeZone),
    };
  }
}
