import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ItemService } from './item.service';
import type { SellerResponse } from '../contracts/ski-swap.contracts';
import { SellerService } from './seller.service';

@Injectable()
export class SellerSelfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly itemService: ItemService,
    private readonly sellerService: SellerService,
  ) {}

  // ─── Seller record ────────────────────────────────────────────────────────

  /** The caller's live seller profile at this org — the thing that grants self-service. */
  async getSellerRecord(orgId: string, userId: string): Promise<{ id: string; businessName: string | null }> {
    const seller = await this.prisma.sellerProfile.findFirst({
      where: { deletedAt: null, membership: { orgId, userId, deletedAt: null } },
      select: { id: true, businessName: true },
    });
    if (!seller) throw new NotFoundException('Seller profile not found');
    return seller;
  }

  // ─── Profile ──────────────────────────────────────────────────────────────

  async getProfile(orgId: string, userId: string): Promise<SellerResponse> {
    const seller = await this.getSellerRecord(orgId, userId);
    return this.sellerService.get(orgId, seller.id);
  }

  async updateProfile(
    orgId: string,
    userId: string,
    data: Parameters<SellerService['patch']>[2],
  ): Promise<SellerResponse> {
    const existing = await this.getSellerRecord(orgId, userId);
    // A business seller may not rename their own business; staff own that field.
    const { businessName: _ignored, ...safe } = data;
    return this.sellerService.patch(orgId, existing.id, safe);
  }

  // ─── Active swaps (for swap selector) ────────────────────────────────────

  async listActiveSwaps(orgId: string): Promise<{ id: string; title: string }[]> {
    const swaps = await this.prisma.skiSwap.findMany({
      where: { orgId, active: true },
      select: { id: true, title: true },
      orderBy: { createdAt: 'desc' },
    });
    return swaps;
  }

  // ─── Items ────────────────────────────────────────────────────────────────

  async listItems(orgId: string, userId: string, swapId?: string) {
    const seller = await this.getSellerRecord(orgId, userId);

    // When no swapId given, collect items from all active swaps
    if (!swapId) {
      const activeSwaps = await this.prisma.skiSwap.findMany({
        where: { orgId, active: true },
        select: { id: true },
      });
      const results = await Promise.all(
        activeSwaps.map((s) =>
          this.itemService.list(orgId, s.id, { sellerId: seller.id }),
        ),
      );
      const items = results.flatMap((r) => r.items);
      return { items, total: items.length };
    }

    return this.itemService.list(orgId, swapId, { sellerId: seller.id });
  }

  async getItem(orgId: string, userId: string, itemId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId } });
    if (!item) throw new NotFoundException('Item not found');
    if (item.sellerId !== seller.id) throw new ForbiddenException('Not your item');
    return this.itemService.get(orgId, item.swapId, itemId);
  }

  async createItem(
    orgId: string,
    userId: string,
    data: { swapId: string; name: string; description?: string; priceCents: number; quantity: number; donateProceeds?: boolean },
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: data.swapId, orgId, active: true } });
    if (!swap) throw new NotFoundException('Active swap not found');
    return this.itemService.create(orgId, data.swapId, { ...data, sellerId: seller.id });
  }

  async updateItem(
    orgId: string,
    userId: string,
    itemId: string,
    data: { name?: string; description?: string | null; priceCents?: number; quantity?: number; donateProceeds?: boolean; hasPrintedTag?: boolean },
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId } });
    return this.itemService.patch(orgId, item.swapId, itemId, data);
  }

  async deleteItem(orgId: string, userId: string, itemId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId } });
    return this.itemService.remove(orgId, item.swapId, itemId);
  }

  async uploadPhoto(
    orgId: string,
    userId: string,
    itemId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId } });
    return this.itemService.uploadPhoto(orgId, item.swapId, itemId, file);
  }

  async deletePhoto(orgId: string, userId: string, itemId: string, photoId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId } });
    return this.itemService.deletePhoto(orgId, item.swapId, itemId, photoId);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async requireOwnership(orgId: string, sellerId: string, itemId: string) {
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId } });
    if (!item) throw new NotFoundException('Item not found');
    if (item.sellerId !== sellerId) throw new ForbiddenException('Not your item');
  }
}
