import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { PublicSellerDetailResponse } from '../contracts/ski-swap.contracts';

@Injectable()
export class PublicSellerService {
  constructor(private readonly prisma: PrismaService) {}

  async getById(sellerId: string): Promise<PublicSellerDetailResponse> {
    const seller = await this.prisma.swapSeller.findUnique({
      where: { id: sellerId },
      include: { org: true },
    });
    if (!seller) throw new NotFoundException('Seller not found');

    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: seller.orgId, moduleKey: 'ski_swap' } },
    });
    if (!orgModule?.enabled) throw new NotFoundException('Seller not found');

    const activeSwaps = await this.prisma.skiSwap.findMany({
      where: { orgId: seller.orgId, active: true },
    });
    if (!activeSwaps.length) {
      return { sellerName: seller.name, orgName: seller.org.name, orgLogoUrl: seller.org.logoUrl ?? null, swaps: [] };
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
          inStock: item.originalQuantity,
          soldCount: 0,
          donateProceeds: item.donateProceeds,
        })),
      })),
    };
  }
}
