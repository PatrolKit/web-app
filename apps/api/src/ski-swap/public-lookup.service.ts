import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory } from './pos/pos.adapter';
import { normalizePhone } from './seller.service';
import type { SellerFindResponse } from '../contracts/ski-swap.contracts';

export interface PublicSellerItem {
  itemId: string;
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
    private readonly posFactory: PosAdapterFactory,
  ) {}

  async lookup(orgSlug: string, phone: string, swapId?: string): Promise<PublicSellerLookupResponse> {
    const org = await this.prisma.organization.findFirst({ where: { slug: orgSlug.toLowerCase() } });
    if (!org) throw new NotFoundException('Organization not found');

    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'ski_swap' } },
    });
    if (!orgModule?.enabled) throw new NotFoundException('Organization not found');

    const normalizedPhone = normalizePhone(phone);
    const seller = await this.prisma.swapSeller.findFirst({ where: { orgId: org.id, phone: normalizedPhone } });
    if (!seller) return { sellerName: '', items: [] };

    const activeSwaps = await this.prisma.skiSwap.findMany({
      where: { orgId: org.id, active: true, ...(swapId ? { id: swapId } : {}) },
    });
    if (!activeSwaps.length) return { sellerName: seller.name, items: [] };

    const activeSwapIds = activeSwaps.map((s) => s.id);
    const dbItems = await this.prisma.swapItem.findMany({
      where: { sellerId: seller.id, swapId: { in: activeSwapIds }, orgId: org.id },
      select: { id: true, name: true, priceCents: true, originalQuantity: true, squareVariationId: true, swapId: true },
    });
    if (!dbItems.length) return { sellerName: seller.name, items: [] };

    // Use the location from the first active swap that has one
    const locationId = activeSwaps.find((s) => s.locationId)?.locationId ?? '';
    const pos = await this.posFactory.forOrg(org.id).catch(() => null);

    let inventoryMap = new Map<string, number>();
    if (pos && locationId) {
      const variationIds = dbItems.map((i) => i.squareVariationId).filter((id): id is string => !!id);
      if (variationIds.length) {
        inventoryMap = await pos.getInventoryCounts(variationIds, locationId).catch(() => new Map());
      }
    }

    const items: PublicSellerItem[] = dbItems.map((item) => {
      const inStock = item.squareVariationId ? (inventoryMap.get(item.squareVariationId) ?? 0) : 0;
      return {
        itemId: item.id,
        name: item.name,
        priceCents: item.priceCents,
        originalQuantity: item.originalQuantity,
        inStock,
        soldCount: Math.max(0, item.originalQuantity - inStock),
      };
    });

    return { sellerName: seller.name, items };
  }

  async findByEmailAndLast4(orgSlug: string, email: string, last4: string): Promise<SellerFindResponse> {
    const org = await this.prisma.organization.findFirst({ where: { slug: orgSlug.toLowerCase() } });
    if (!org) throw new NotFoundException('No seller found.');

    const orgModule = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'ski_swap' } },
    });
    if (!orgModule?.enabled) throw new NotFoundException('No seller found.');

    const sellers = await this.prisma.swapSeller.findMany({
      where: { orgId: org.id, email: email.toLowerCase() },
    });

    const seller = sellers.find((s) => normalizePhone(s.phone).slice(-4) === last4);
    if (!seller) throw new NotFoundException('No seller found.');

    return { sellerId: seller.id };
  }
}
