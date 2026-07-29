import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClientService } from './square-client.service';
import { normalizePhone } from './seller.service';

export interface PublicSellerItem {
  squareItemId: string;
  name: string;
  priceCents: number;
  originalQuantity: number;
  inStock: number;
  soldCount: number;
}

export interface PublicSellerLookupResponse {
  sellerName: string;
  items: PublicSellerItem[];
}

@Injectable()
export class PublicLookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly squareClient: SquareClientService,
  ) {}

  async lookup(
    orgSlug: string,
    phone: string,
    swapId?: string,
  ): Promise<PublicSellerLookupResponse> {
    // Resolve org by slug (case-insensitive)
    const org = await this.prisma.organization.findFirst({
      where: { slug: orgSlug.toLowerCase() },
    });
    if (!org) throw new NotFoundException('Organization not found');

    // Verify ski_swap module is enabled for this org
    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'ski_swap' } },
    });
    if (!orgModule?.enabled) throw new NotFoundException('Organization not found');

    const normalizedPhone = normalizePhone(phone);
    const seller = await this.prisma.swapSeller.findFirst({
      where: { orgId: org.id, phone: normalizedPhone },
    });

    // Return empty list without revealing whether the phone is known
    if (!seller) return { sellerName: '', items: [] };

    // Fetch active swaps for this org (optionally filtered by swapId)
    const activeSwaps = await this.prisma.skiSwap.findMany({
      where: { orgId: org.id, active: true, ...(swapId ? { id: swapId } : {}) },
    });
    if (activeSwaps.length === 0) return { sellerName: seller.name, items: [] };

    const activeSwapIds = activeSwaps.map((s) => s.id);

    // Find all items assigned to this seller across active swaps
    const assignments = await this.prisma.swapItemSeller.findMany({
      where: { sellerId: seller.id, swapId: { in: activeSwapIds } },
    });
    if (assignments.length === 0) return { sellerName: seller.name, items: [] };

    // Each swap carries its own locationId; use the first non-empty one for inventory
    const locationId = activeSwaps.find((s) => s.locationId)?.locationId ?? '';

    const squareConfig = await this.prisma.squareConfig.findUnique({ where: { orgId: org.id } });
    if (!squareConfig) return { sellerName: seller.name, items: [] };

    const client = await this.squareClient.forOrg(org.id);

    const variationIds = assignments.map((a) => a.squareVariationId);
    const inventoryPage = await client.inventory.batchGetCounts({
      catalogObjectIds: variationIds,
      locationIds: locationId ? [locationId] : [],
    });

    const inventoryMap = new Map<string, number>();
    for (const count of inventoryPage.data) {
      if (count.state === 'IN_STOCK' && count.catalogObjectId && count.quantity) {
        inventoryMap.set(count.catalogObjectId, Math.floor(parseFloat(count.quantity)));
      }
    }

    // Batch-fetch catalog objects for name + price
    const squareItemIds = assignments.map((a) => a.squareItemId);
    const catalogRes = await client.catalog.batchGet({
      objectIds: squareItemIds,
      includeRelatedObjects: false,
    });

    const catalogMap = new Map<string, { name: string; priceCents: number }>();
    for (const obj of catalogRes.objects ?? []) {
      if (obj.type !== 'ITEM' || !obj.itemData) continue;
      const item = obj as import('square').Square.CatalogObject.Item;
      const variation = item.itemData?.variations?.[0];
      const priceCents = Number(
        variation?.type === 'ITEM_VARIATION'
          ? (variation as import('square').Square.CatalogObject.ItemVariation).itemVariationData?.priceMoney?.amount ?? 0
          : 0,
      );
      catalogMap.set(obj.id, { name: item.itemData?.name ?? '', priceCents });
    }

    const items: PublicSellerItem[] = assignments.map((a) => {
      const catalog = catalogMap.get(a.squareItemId) ?? { name: '', priceCents: 0 };
      const inStock = inventoryMap.get(a.squareVariationId) ?? 0;
      const soldCount = Math.max(0, a.originalQuantity - inStock);
      return {
        squareItemId: a.squareItemId,
        name: catalog.name,
        priceCents: catalog.priceCents,
        originalQuantity: a.originalQuantity,
        inStock,
        soldCount,
      };
    });

    return { sellerName: seller.name, items };
  }
}
