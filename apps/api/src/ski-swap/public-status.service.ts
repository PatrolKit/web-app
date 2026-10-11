import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory } from './pos/pos.adapter';
import { publicItemStatus, type PublicItemStatus } from './public-item-status';

export interface PublicSwapStatusPage {
  orgName: string;
  orgLogoUrl: string | null;
  swapTitle: string;
}

export interface PublicSkuStatus {
  sku: string;
  name: string;
  status: PublicItemStatus;
  /** With more than one unit: how many of `quantity` have sold. */
  soldCount?: number;
  quantity?: number;
}

/**
 * Unauthenticated SKU Lookup (Plan 33): one SKU, in one swap, for anyone.
 *
 * It tells the item's name and status and nothing else. SKUs are sequential,
 * so anything more (a price, a seller) is a list anyone could step through.
 * A missing org, a missing swap, the switch off and an unknown SKU are all the
 * same 404, so a closed swap can't be told from one that isn't there.
 */
@Injectable()
export class PublicStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
  ) {}

  async page(orgSlug: string, swapSlug: string): Promise<PublicSwapStatusPage> {
    const { org, swap } = await this.openSwap(orgSlug, swapSlug);
    return { orgName: org.name, orgLogoUrl: org.logoUrl ?? null, swapTitle: swap.title };
  }

  async sku(orgSlug: string, swapSlug: string, rawSku: string): Promise<PublicSkuStatus> {
    const { org, swap } = await this.openSwap(orgSlug, swapSlug);
    const found = await this.lookUp(org.id, swap, rawSku);
    if (!found) throw notFound();
    const { item, status, soldCount, quantity } = found;
    return {
      sku: item.sku,
      name: item.name,
      status,
      // Only where there's something to count; "1 of 1" says nothing "Sold" doesn't.
      ...(quantity > 1 && soldCount !== null ? { soldCount, quantity } : {}),
    };
  }

  /**
   * The patrol's own devices' answer (the iPad's Item Status Kiosk): the same
   * status as the public lookup, by the same lookup, but for a device token,
   * whatever the SKU Lookup switch says, and with only the verdict and the
   * tag, since a kiosk faces the public. 404 `ITEM_NOT_FOUND` for no such tag.
   */
  async deviceSku(orgId: string, swapId: string, rawSku: string): Promise<{ sku: string; status: PublicItemStatus }> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true, locationId: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const found = await this.lookUp(orgId, swap, rawSku);
    if (!found) throw new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'No item with that SKU in this swap.' });
    return { sku: found.item.sku, status: found.status };
  }

  /** One live item by its tag, and its status from Square's count read now. Null when there's no such item. */
  private async lookUp(orgId: string, swap: { id: string; locationId: string | null }, rawSku: string) {
    const sku = rawSku.trim();
    const item = sku
      ? await this.prisma.swapItem.findFirst({
          where: { orgId, swapId: swap.id, sku, deletedAt: null },
          select: { sku: true, name: true, consignedAt: true, squareVariationId: true, originalQuantity: true, pickedUpAt: true },
        })
      : null;
    if (!item) return null;

    // A failed or impossible read is null, which the helper reports as unknown.
    let counts: Map<string, number> | null = null;
    if (item.consignedAt && !item.pickedUpAt && item.squareVariationId && swap.locationId) {
      const pos = await this.posFactory.forOrg(orgId).catch(() => null);
      counts = pos ? await pos.getInventoryCounts([item.squareVariationId], swap.locationId).catch(() => null) : null;
    }
    return { item, ...publicItemStatus(item, counts) };
  }

  private async openSwap(orgSlug: string, swapSlug: string) {
    const org = await this.prisma.organization.findFirst({
      where: { slug: orgSlug.toLowerCase(), status: 'active' },
      select: { id: true, name: true, logoUrl: true },
    });
    if (!org) throw notFound();
    const module = await this.prisma.orgModule.findUnique({
      where: { orgId_moduleKey: { orgId: org.id, moduleKey: 'ski_swap' } },
    });
    if (!module?.enabled) throw notFound();
    const swap = await this.prisma.skiSwap.findFirst({
      where: { orgId: org.id, slug: swapSlug.toLowerCase(), skuLookupEnabled: true },
      select: { id: true, title: true, locationId: true },
    });
    if (!swap) throw notFound();
    return { org, swap };
  }
}

function notFound() {
  return new NotFoundException('No item with that SKU in this swap.');
}
