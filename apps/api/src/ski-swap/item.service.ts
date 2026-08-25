import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory } from './pos/pos.adapter';
import { SellerService, SELLER_NAME_INCLUDE, sellerDisplayName, type SellerNameRow } from './seller.service';
import { S3Service } from './s3.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { formatSku } from './sku.util';
import { createId } from '@paralleldrive/cuid2';
import { extname } from 'path';
import sharp from 'sharp';

export interface ItemPhotoResponse { id: string; url: string; }

export interface ItemResponse {
  id: string; swapId: string; orgId: string;
  name: string; description: string | null;
  sku: string; priceCents: number; originalQuantity: number;
  inStock: number; soldCount: number; squareSynced: boolean;
  donateProceeds: boolean; hasPrintedTag: boolean;
  seller: { id: string; displayName: string; phone: string | null } | null;
  photos: ItemPhotoResponse[];
}

type SwapShape = { id: string; title: string; squareCategoryId: string; locationId: string; skuPrefix: string; skuCounter: number };

@Injectable()
export class ItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
    private readonly sellerService: SellerService,
    private readonly s3: S3Service,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(orgId: string, swapId: string, opts: { query?: string; sellerId?: string; skip?: number; take?: number; updatedSince?: string }): Promise<{ items: ItemResponse[]; total: number }> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const where = {
      swapId, orgId,
      ...(opts.query ? { OR: [
        { name: { contains: opts.query } },
        { sku: { contains: opts.query } },
        { seller: { businessName: { contains: opts.query } } },
        { seller: { membership: { user: { firstName: { contains: opts.query } } } } },
        { seller: { membership: { user: { lastName: { contains: opts.query } } } } },
        { seller: { membership: { user: { email: { contains: opts.query } } } } },
        { seller: { membership: { user: { phone: { contains: opts.query.replace(/\D/g, '') } } } } },
      ] } : {}),
      ...(opts.sellerId ? { sellerId: opts.sellerId } : {}),
      ...(opts.updatedSince ? { updatedAt: { gt: new Date(opts.updatedSince) } } : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.swapItem.findMany({ where, include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } }, orderBy: { createdAt: 'desc' }, skip: opts.skip ?? 0, take: opts.take ?? 50 }),
      this.prisma.swapItem.count({ where }),
    ]);
    const inventoryMap = await this.fetchInventoryMap(orgId, swap, items);
    return { total, items: items.map((i) => this.toResponse(i, inventoryMap)) };
  }

  async get(orgId: string, swapId: string, itemId: string): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId }, include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } } });
    if (!item) throw new NotFoundException('Item not found');
    const inventoryMap = await this.fetchInventoryMap(orgId, swap, [item]);
    return this.toResponse(item, inventoryMap);
  }

  async create(orgId: string, swapId: string, data: { name: string; description?: string; priceCents: number; quantity: number; sellerId?: string; donateProceeds?: boolean; sku?: string }, idempotencyKey?: string): Promise<ItemResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(idempotencyKey);
      if (cached) return cached as unknown as ItemResponse;
    }

    const swap = await this.findSwapOrThrow(orgId, swapId);
    if (data.sellerId) await this.sellerService.findOrThrow(orgId, data.sellerId);

    let sku: string;
    if (data.sku) {
      sku = data.sku;
    } else {
      const updatedSwap = await this.prisma.skiSwap.update({ where: { id: swapId }, data: { skuCounter: { increment: 1 } } });
      sku = formatSku(updatedSwap.skuPrefix, updatedSwap.skuCounter);
    }

    const item = await this.prisma.swapItem.create({
      data: { id: createId(), swapId, orgId, sellerId: data.sellerId ?? null, name: data.name, description: data.description ?? null, priceCents: data.priceCents, sku, originalQuantity: data.quantity, donateProceeds: data.donateProceeds ?? false },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: true },
    });

    await this.syncItemToPos(orgId, swap, item);

    const refreshed = await this.prisma.swapItem.findUniqueOrThrow({ where: { id: item.id }, include: { seller: { include: SELLER_NAME_INCLUDE }, photos: true } });
    const inventoryMap = await this.fetchInventoryMap(orgId, swap, [refreshed]);
    const response = this.toResponse(refreshed, inventoryMap);

    if (idempotencyKey) {
      await this.idempotency.save(idempotencyKey, response as unknown as Record<string, unknown>);
    }

    return response;
  }

  async patch(orgId: string, swapId: string, itemId: string, data: { name?: string; description?: string | null; priceCents?: number; quantity?: number; sellerId?: string | null; donateProceeds?: boolean; hasPrintedTag?: boolean }): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const existing = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId } });
    if (!existing) throw new NotFoundException('Item not found');
    if (data.sellerId) await this.sellerService.findOrThrow(orgId, data.sellerId);

    const updated = await this.prisma.swapItem.update({
      where: { id: itemId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.priceCents !== undefined ? { priceCents: data.priceCents } : {}),
        ...(data.quantity !== undefined ? { originalQuantity: data.quantity } : {}),
        ...(data.sellerId !== undefined ? { sellerId: data.sellerId } : {}),
        ...(data.donateProceeds !== undefined ? { donateProceeds: data.donateProceeds } : {}),
        ...(data.hasPrintedTag !== undefined ? { hasPrintedTag: data.hasPrintedTag } : {}),
      },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
    });

    await this.syncItemToPos(orgId, swap, updated);

    if (data.quantity !== undefined && updated.squareVariationId && swap.locationId) {
      const pos = await this.posFactory.forOrg(orgId);
      if (pos) await pos.setInventoryPhysicalCount(updated.squareVariationId, swap.locationId, data.quantity).catch(() => {});
    }

    const inventoryMap = await this.fetchInventoryMap(orgId, swap, [updated]);
    return this.toResponse(updated, inventoryMap);
  }

  async remove(orgId: string, swapId: string, itemId: string): Promise<void> {
    await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId }, include: { photos: true } });
    if (!item) throw new NotFoundException('Item not found');

    for (const photo of item.photos) {
      await this.s3.delete(photo.s3Key).catch(() => {});
      if (photo.squareImageId) {
        const pos = await this.posFactory.forOrg(orgId);
        if (pos) await pos.deleteImage(photo.squareImageId).catch(() => {});
      }
    }
    if (item.squareItemId) {
      const pos = await this.posFactory.forOrg(orgId);
      if (pos) await pos.deleteItem(item.squareItemId).catch(() => {});
    }
    await this.prisma.swapItem.delete({ where: { id: itemId } });
  }

  async uploadPhoto(orgId: string, swapId: string, itemId: string, file: { buffer: Buffer; mimetype: string; originalname: string }): Promise<{ id: string; url: string }> {
    await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId } });
    if (!item) throw new NotFoundException('Item not found');

    // Resize to max 1200px on the longest side, JPEG 85% — keeps files well under
    // Square's 15MB limit and reduces S3 storage for high-volume swaps.
    const resized = await sharp(file.buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const s3Key = `photos/${orgId}/${swapId}/${itemId}/${createId()}.jpg`;
    let url = '';
    let s3KeyStored = '';

    if (this.s3.configured) {
      try {
        url = await this.s3.upload(s3Key, resized, 'image/jpeg');
        s3KeyStored = s3Key;
      } catch (err) {
        console.error('[S3] upload failed, falling back to Square CDN:', err);
      }
    }

    let squareImageId: string | undefined;
    if (item.squareItemId) {
      const pos = await this.posFactory.forOrg(orgId);
      if (pos) {
        const res = await pos.uploadImage(item.squareItemId, resized, 'image/jpeg').catch((err) => { console.error('[Square] uploadImage failed:', err); return null; });
        if (res) { squareImageId = res.posImageId; if (!url) url = res.imageUrl; }
      }
    }

    if (!url) throw new BadRequestException('No photo storage is configured');

    const displayOrder = await this.prisma.swapItemPhoto.count({ where: { itemId } });
    const photo = await this.prisma.swapItemPhoto.create({
      data: { id: createId(), itemId, s3Key: s3KeyStored, url, squareImageId, displayOrder },
    });
    return { id: photo.id, url: photo.url };
  }

  async deletePhoto(orgId: string, swapId: string, itemId: string, photoId: string): Promise<void> {
    await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId } });
    if (!item) throw new NotFoundException('Item not found');
    const photo = await this.prisma.swapItemPhoto.findFirst({ where: { id: photoId, itemId } });
    if (!photo) throw new NotFoundException('Photo not found');

    await this.s3.delete(photo.s3Key).catch(() => {});
    if (photo.squareImageId) {
      const pos = await this.posFactory.forOrg(orgId);
      if (pos) await pos.deleteImage(photo.squareImageId).catch(() => {});
    }
    await this.prisma.swapItemPhoto.delete({ where: { id: photoId } });
  }

  private async findSwapOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  private async syncItemToPos(orgId: string, swap: Pick<SwapShape, 'id' | 'title' | 'squareCategoryId' | 'locationId'>, item: { id: string; name: string; description: string | null; priceCents: number; sku: string; originalQuantity: number; squareItemId: string | null; squareVariationId: string | null }): Promise<void> {
    if (!swap.locationId) return;
    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) return;
    try {
      const result = await pos.syncItem(
        { posItemId: item.squareItemId ?? undefined, posVariationId: item.squareVariationId ?? undefined, name: item.name, description: item.description ?? undefined, priceCents: item.priceCents, sku: item.sku, categoryId: swap.squareCategoryId, categoryName: swap.title },
        swap.locationId,
        item.originalQuantity,
      );
      // Persist category ID if it was recreated (stale category recovered)
      if (result.resolvedCategoryId !== swap.squareCategoryId) {
        await this.prisma.skiSwap.update({ where: { id: swap.id }, data: { squareCategoryId: result.resolvedCategoryId } });
      }
      await this.prisma.swapItem.update({ where: { id: item.id }, data: { squareItemId: result.posItemId, squareVariationId: result.posVariationId, lastSyncedAt: new Date() } });
    } catch (err) { console.error('[Square] syncItemToPos failed:', err); }
  }

  private async fetchInventoryMap(orgId: string, swap: { locationId: string }, items: { squareVariationId: string | null }[]): Promise<Map<string, number>> {
    if (!swap.locationId) return new Map();
    const ids = items.map((i) => i.squareVariationId).filter((id): id is string => !!id);
    if (!ids.length) return new Map();
    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) return new Map();
    return pos.getInventoryCounts(ids, swap.locationId).catch(() => new Map());
  }

  private toResponse(item: { id: string; swapId: string; orgId: string; name: string; description: string | null; sku: string; priceCents: number; originalQuantity: number; squareItemId: string | null; squareVariationId: string | null; donateProceeds: boolean; hasPrintedTag: boolean; seller: (SellerNameRow & { id: string }) | null; photos: { id: string; url: string }[] }, inventoryMap: Map<string, number>): ItemResponse {
    const inStock = item.squareVariationId ? (inventoryMap.get(item.squareVariationId) ?? 0) : 0;
    return {
      id: item.id, swapId: item.swapId, orgId: item.orgId,
      name: item.name, description: item.description,
      sku: item.sku, priceCents: item.priceCents, originalQuantity: item.originalQuantity,
      inStock, soldCount: Math.max(0, item.originalQuantity - inStock),
      squareSynced: !!item.squareItemId,
      donateProceeds: item.donateProceeds,
      hasPrintedTag: item.hasPrintedTag,
      seller: item.seller
        ? {
            id: item.seller.id,
            displayName: sellerDisplayName(item.seller) ?? 'Unnamed',
            phone: item.seller.membership.user.phone ?? null,
          }
        : null,
      photos: item.photos.map((p) => ({ id: p.id, url: p.url })),
    };
  }
}
