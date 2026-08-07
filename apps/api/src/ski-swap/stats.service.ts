import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory } from './pos/pos.adapter';

export interface SwapStats {
  totalItems: number;
  totalSellers: number;
  itemsSold: number;
  grossRevenueCents: number;
}

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
  ) {}

  async getSwapStats(orgId: string, swapId: string): Promise<SwapStats> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');

    const [totalItems, totalSellers, items] = await this.prisma.$transaction([
      this.prisma.swapItem.count({ where: { swapId, orgId } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId, sellerId: { not: null } }, distinct: ['sellerId'], select: { sellerId: true } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId }, select: { squareVariationId: true, originalQuantity: true, priceCents: true } }),
    ]);

    const syncedItems = items.filter((i) => i.squareVariationId);
    if (!syncedItems.length || !swap.locationId) {
      return { totalItems, totalSellers: totalSellers.length, itemsSold: 0, grossRevenueCents: 0 };
    }

    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) {
      return { totalItems, totalSellers: totalSellers.length, itemsSold: 0, grossRevenueCents: 0 };
    }

    const variationIds = syncedItems.map((i) => i.squareVariationId as string);
    const inventoryMap = await pos.getInventoryCounts(variationIds, swap.locationId).catch(() => new Map<string, number>());

    let itemsSold = 0;
    let grossRevenueCents = 0;
    for (const item of syncedItems) {
      const inStock = inventoryMap.get(item.squareVariationId as string) ?? 0;
      const sold = Math.max(0, item.originalQuantity - inStock);
      itemsSold += sold;
      grossRevenueCents += sold * item.priceCents;
    }

    return { totalItems, totalSellers: totalSellers.length, itemsSold, grossRevenueCents };
  }
}
