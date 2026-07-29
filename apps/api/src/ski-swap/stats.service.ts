import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClientService } from './square-client.service';

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
    private readonly squareClient: SquareClientService,
  ) {}

  async getSwapStats(orgId: string, swapId: string): Promise<SwapStats> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');

    const client = await this.squareClient.forOrg(orgId);

    // Total sellers: distinct sellers with items in this swap
    const totalSellers = await this.prisma.swapItemSeller.findMany({
      where: { swapId },
      distinct: ['sellerId'],
    });

    // Fetch all local item-seller mappings for this swap
    const assignments = await this.prisma.swapItemSeller.findMany({ where: { swapId } });

    // Count total items via Square (SearchCatalogItems by category)
    let totalItems = 0;
    let cursor: string | undefined;
    do {
      const res = await client.catalog.searchItems({
        categoryIds: [swap.squareCategoryId],
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      totalItems += (res.items ?? []).length;
      cursor = res.cursor;
    } while (cursor);

    if (assignments.length === 0) {
      return { totalItems, totalSellers: totalSellers.length, itemsSold: 0, grossRevenueCents: 0 };
    }

    // Batch-fetch current inventory for all tracked variations
    const variationIds = assignments.map((a) => a.squareVariationId);
    const page = await client.inventory.batchGetCounts({
      catalogObjectIds: variationIds,
      locationIds: [swap.locationId],
    });

    const inventoryMap = new Map<string, number>();
    for (const count of page.data) {
      if (count.state === 'IN_STOCK' && count.catalogObjectId && count.quantity) {
        inventoryMap.set(count.catalogObjectId, Math.floor(parseFloat(count.quantity)));
      }
    }

    // Fetch catalog prices for items that have sold units
    const soldAssignments = assignments.filter((a) => {
      const inStock = inventoryMap.get(a.squareVariationId) ?? 0;
      return a.originalQuantity - inStock > 0;
    });

    const priceMap = new Map<string, number>();
    if (soldAssignments.length > 0) {
      const squareItemIds = soldAssignments.map((a) => a.squareItemId);
      // Batch-retrieve catalog objects for price data
      const batchRes = await client.catalog.batchGet({
        objectIds: squareItemIds,
        includeRelatedObjects: false,
      });
      for (const obj of batchRes.objects ?? []) {
        if (obj.type !== 'ITEM' || !obj.itemData) continue;
        const item = obj as import('square').Square.CatalogObject.Item;
        const variation = item.itemData?.variations?.[0];
        const priceCents = Number(variation?.type === 'ITEM_VARIATION'
          ? (variation as import('square').Square.CatalogObject.ItemVariation).itemVariationData?.priceMoney?.amount ?? 0
          : 0);
        priceMap.set(obj.id, priceCents);
      }
    }

    let itemsSold = 0;
    let grossRevenueCents = 0;

    for (const a of assignments) {
      const inStock = inventoryMap.get(a.squareVariationId) ?? 0;
      const sold = Math.max(0, a.originalQuantity - inStock);
      itemsSold += sold;
      if (sold > 0) {
        grossRevenueCents += sold * (priceMap.get(a.squareItemId) ?? 0);
      }
    }

    return {
      totalItems,
      totalSellers: totalSellers.length,
      itemsSold,
      grossRevenueCents,
    };
  }
}
