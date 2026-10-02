import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory } from './pos/pos.adapter';

export interface SwapStats {
  totalItems: number;
  totalSellers: number;
  itemsSold: number;
  grossRevenueCents: number;
  /** False when Square could not be read; `itemsSold` and revenue are then 0, not answers. */
  inventoryKnown: boolean;
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
      this.prisma.swapItem.count({ where: { swapId, orgId, deletedAt: null } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId, sellerId: { not: null }, deletedAt: null }, distinct: ['sellerId'], select: { sellerId: true } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId, deletedAt: null }, select: { squareVariationId: true, originalQuantity: true, priceCents: true } }),
    ]);

    const syncedItems = items.filter((i) => i.squareVariationId);
    if (!syncedItems.length || !swap.locationId) {
      return { totalItems, totalSellers: totalSellers.length, itemsSold: 0, grossRevenueCents: 0, inventoryKnown: true };
    }

    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) {
      return { totalItems, totalSellers: totalSellers.length, itemsSold: 0, grossRevenueCents: 0, inventoryKnown: true };
    }

    const variationIds = syncedItems.map((i) => i.squareVariationId as string);
    // A failed read is not "nothing in stock". With an empty map every synced
    // item counted as sold and the whole swap's list price became revenue.
    const inventoryMap = await pos.getInventoryCounts(variationIds, swap.locationId).catch(() => null);
    if (!inventoryMap) {
      return { totalItems, totalSellers: totalSellers.length, itemsSold: 0, grossRevenueCents: 0, inventoryKnown: false };
    }

    let itemsSold = 0;
    let grossRevenueCents = 0;
    for (const item of syncedItems) {
      const inStock = inventoryMap.get(item.squareVariationId as string) ?? 0;
      const sold = Math.max(0, item.originalQuantity - inStock);
      itemsSold += sold;
      grossRevenueCents += sold * item.priceCents;
    }

    return { totalItems, totalSellers: totalSellers.length, itemsSold, grossRevenueCents, inventoryKnown: true };
  }
}
