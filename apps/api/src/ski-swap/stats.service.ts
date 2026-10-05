import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory } from './pos/pos.adapter';

export interface SwapStats {
  totalItems: number;
  totalSellers: number;
  itemsSold: number;
  /** At listed prices, so only for priced items. */
  grossRevenueCents: number;
  /**
   * Units of tickets sold before they were priced (Plan 32). Their price was
   * typed at the register and isn't in `grossRevenueCents` until a payout run
   * records it.
   */
  unpricedSold: number;
  /** Tickets checked in without a price and still without one, sold or not (Plan 32). */
  unpricedItems: number;
  /** False when Square could not be read; `itemsSold` and revenue are then 0, not answers. */
  inventoryKnown: boolean;
  /**
   * What staff have accepted for sale, at listed prices: priced, consigned
   * items, sold or not. Read from the database, so it moves during check-in,
   * before anything has sold.
   */
  consignedValueCents: number;
  /** Consigned items, priced or not. */
  consignedItems: number;
  /** Consigned items still without a price, so not in `consignedValueCents`. */
  consignedUnpriced: number;
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

    const [totalItems, totalSellers, items, unpricedItems] = await this.prisma.$transaction([
      this.prisma.swapItem.count({ where: { swapId, orgId, deletedAt: null } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId, sellerId: { not: null }, deletedAt: null }, distinct: ['sellerId'], select: { sellerId: true } }),
      this.prisma.swapItem.findMany({ where: { swapId, orgId, deletedAt: null }, select: { squareVariationId: true, originalQuantity: true, priceCents: true, consignedAt: true } }),
      this.prisma.swapItem.count({ where: { swapId, orgId, deletedAt: null, priceCents: null } }),
    ]);

    const consigned = items.filter((i) => i.consignedAt !== null);
    const base = {
      totalItems,
      totalSellers: totalSellers.length,
      unpricedItems,
      consignedItems: consigned.length,
      consignedUnpriced: consigned.filter((i) => i.priceCents === null).length,
      consignedValueCents: consigned.reduce((sum, i) => sum + (i.priceCents ?? 0) * i.originalQuantity, 0),
    };

    const syncedItems = items.filter((i) => i.squareVariationId);
    if (!syncedItems.length || !swap.locationId) {
      return { ...base, itemsSold: 0, grossRevenueCents: 0, unpricedSold: 0, inventoryKnown: true };
    }

    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) {
      return { ...base, itemsSold: 0, grossRevenueCents: 0, unpricedSold: 0, inventoryKnown: true };
    }

    const variationIds = syncedItems.map((i) => i.squareVariationId as string);
    // A failed read is not "nothing in stock". With an empty map every synced
    // item counted as sold and the whole swap's list price became revenue.
    const inventoryMap = await pos.getInventoryCounts(variationIds, swap.locationId).catch(() => null);
    if (!inventoryMap) {
      return { ...base, itemsSold: 0, grossRevenueCents: 0, unpricedSold: 0, inventoryKnown: false };
    }

    let itemsSold = 0;
    let grossRevenueCents = 0;
    let unpricedSold = 0;
    for (const item of syncedItems) {
      const inStock = inventoryMap.get(item.squareVariationId as string) ?? 0;
      const sold = Math.max(0, item.originalQuantity - inStock);
      itemsSold += sold;
      if (item.priceCents === null) unpricedSold += sold;
      else grossRevenueCents += sold * item.priceCents;
    }

    return { ...base, itemsSold, grossRevenueCents, unpricedSold, inventoryKnown: true };
  }
}
