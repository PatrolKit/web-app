import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SquareClientService } from './square-client.service';
import { SellerService } from './seller.service';
import { formatSku } from './sku.util';
import { createId } from '@paralleldrive/cuid2';
import { v4 as uuidv4 } from 'uuid';
import type { Square } from 'square';
import type { ItemResponse } from '../contracts/ski-swap.contracts';

// ─── Type helpers ─────────────────────────────────────────────────────────────

/** Narrow CatalogObject to Item variant; returns null if not an item. */
function asItem(obj: Square.CatalogObject | undefined | null) {
  if (obj?.type === 'ITEM') return obj as Square.CatalogObject.Item;
  return null;
}

/** Narrow CatalogObject to ItemVariation variant; returns null if not a variation. */
function asVariation(obj: Square.CatalogObject | undefined | null) {
  if (obj?.type === 'ITEM_VARIATION') return obj as Square.CatalogObject.ItemVariation;
  return null;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly squareClient: SquareClientService,
    private readonly sellerService: SellerService,
  ) {}

  // ─── List ─────────────────────────────────────────────────────────────────

  async list(
    orgId: string,
    swapId: string,
    opts: { cursor?: string; limit?: number; query?: string },
  ): Promise<{ items: ItemResponse[]; cursor?: string }> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    
    const client = await this.squareClient.forOrg(orgId);

    const searchRes = await client.catalog.searchItems({
      categoryIds: [swap.squareCategoryId],
      ...(opts.query ? { textFilter: opts.query } : {}),
      limit: opts.limit ?? 50,
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
    });

    const squareItems = (searchRes.items ?? []).map(asItem).filter((i): i is Square.CatalogObject.Item => i !== null);
    if (squareItems.length === 0) return { items: [] };

    // Collect all variation IDs for a batch inventory fetch
    const variationIds = squareItems
      .flatMap((item) => item.itemData?.variations ?? [])
      .map((v) => v.id)
      .filter((id): id is string => Boolean(id));

    const inventoryMap = await this.fetchInventoryMap(client, variationIds, swap.locationId);

    const squareItemIds = squareItems.map((i) => i.id).filter((id): id is string => Boolean(id));
    const assignments = await this.prisma.swapItemSeller.findMany({
      where: { swapId, squareItemId: { in: squareItemIds } },
      include: { seller: true },
    });
    const assignmentMap = new Map(assignments.map((a) => [a.squareItemId, a]));

    const items: ItemResponse[] = squareItems.map((item) => {
      const firstVariation = asVariation(item.itemData?.variations?.[0]);
      const squareVariationId = item.itemData?.variations?.[0]?.id ?? '';
      const priceCents = Number(firstVariation?.itemVariationData?.priceMoney?.amount ?? 0);
      const inStock = inventoryMap.get(squareVariationId) ?? 0;
      const assignment = assignmentMap.get(item.id);
      const soldCount = Math.max(0, (assignment?.originalQuantity ?? 0) - inStock);

      return {
        squareItemId: item.id,
        squareVariationId,
        swapId,
        name: item.itemData?.name ?? '',
        description: item.itemData?.description ?? null,
        sku: firstVariation?.itemVariationData?.sku ?? '',
        priceCents,
        inStock,
        soldCount,
        seller: assignment?.seller
          ? { id: assignment.seller.id, name: assignment.seller.name, phone: assignment.seller.phone }
          : null,
        squareImageIds: item.itemData?.imageIds ?? [],
      };
    });

    return { items, cursor: searchRes.cursor };
  }

  // ─── Get single ───────────────────────────────────────────────────────────

  async get(orgId: string, swapId: string, squareItemId: string): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    
    const client = await this.squareClient.forOrg(orgId);

    const objRes = await client.catalog.object.get({ objectId: squareItemId });
    const item = asItem(objRes.object);
    if (!item) throw new NotFoundException('Item not found in Square');

    if (item.itemData?.categoryId !== swap.squareCategoryId) {
      throw new NotFoundException('Item does not belong to this swap');
    }

    const firstVariation = asVariation(item.itemData?.variations?.[0]);
    const squareVariationId = item.itemData?.variations?.[0]?.id ?? '';
    const inventoryMap = await this.fetchInventoryMap(client, squareVariationId ? [squareVariationId] : [], swap.locationId);

    const assignment = await this.prisma.swapItemSeller.findUnique({
      where: { swapId_squareItemId: { swapId, squareItemId } },
      include: { seller: true },
    });

    const priceCents = Number(firstVariation?.itemVariationData?.priceMoney?.amount ?? 0);
    const inStock = inventoryMap.get(squareVariationId) ?? 0;
    const soldCount = Math.max(0, (assignment?.originalQuantity ?? 0) - inStock);

    return {
      squareItemId,
      squareVariationId,
      swapId,
      name: item.itemData?.name ?? '',
      description: item.itemData?.description ?? null,
      sku: firstVariation?.itemVariationData?.sku ?? '',
      priceCents,
      inStock,
      soldCount,
      seller: assignment?.seller
        ? { id: assignment.seller.id, name: assignment.seller.name, phone: assignment.seller.phone }
        : null,
      squareImageIds: item.itemData?.imageIds ?? [],
    };
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  async create(
    orgId: string,
    swapId: string,
    data: { name: string; description?: string; priceCents: number; quantity: number; sellerId?: string },
  ): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    
    const client = await this.squareClient.forOrg(orgId);

    if (data.sellerId) await this.sellerService.findOrThrow(orgId, data.sellerId);

    // Atomically claim the next SKU counter value
    const updatedSwap = await this.prisma.skiSwap.update({
      where: { id: swapId },
      data: { skuCounter: { increment: 1 } },
    });
    const sku = formatSku(swap.skuPrefix, updatedSwap.skuCounter);

    const upsertRes = await client.catalog.object.upsert({
      idempotencyKey: uuidv4(),
      object: {
        type: 'ITEM',
        id: '#item',
        itemData: {
          name: data.name,
          description: data.description,
          categoryId: swap.squareCategoryId,
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: '#variation',
              itemVariationData: {
                name: 'Regular',
                sku,
                pricingType: 'FIXED_PRICING',
                priceMoney: { amount: BigInt(data.priceCents), currency: 'USD' },
                stockable: true,
                trackInventory: true,
                inventoryAlertType: 'LOW_QUANTITY',
                inventoryAlertThreshold: BigInt(1),
              },
            },
          ],
        },
      },
    });

    const squareItemId = upsertRes.catalogObject?.id;
    if (!squareItemId) throw new BadRequestException('Square did not return an item ID');

    // Prefer idMappings for the variation ID (most reliable after batch creation)
    const idMappings = upsertRes.idMappings ?? [];
    const squareVariationId =
      idMappings.find((m) => m.clientObjectId === '#variation')?.objectId ??
      asItem(upsertRes.catalogObject)?.itemData?.variations?.[0]?.id;

    if (!squareVariationId) throw new BadRequestException('Square did not return a variation ID');

    // Set initial inventory via RECEIVE_STOCK adjustment
    await client.inventory.batchCreateChanges({
      idempotencyKey: uuidv4(),
      changes: [
        {
          type: 'ADJUSTMENT',
          adjustment: {
            catalogObjectId: squareVariationId,
            fromState: 'NONE',
            toState: 'IN_STOCK',
            toLocationId: swap.locationId,
            quantity: String(data.quantity),
            occurredAt: new Date().toISOString(),
          },
        },
      ],
    });

    if (data.sellerId) {
      await this.prisma.swapItemSeller.create({
        data: {
          id: createId(),
          swapId,
          sellerId: data.sellerId,
          squareItemId,
          squareVariationId,
          originalQuantity: data.quantity,
        },
      });
    }

    return this.get(orgId, swapId, squareItemId);
  }

  // ─── Patch ────────────────────────────────────────────────────────────────

  async patch(
    orgId: string,
    swapId: string,
    squareItemId: string,
    data: { name?: string; description?: string | null; priceCents?: number; quantity?: number; sellerId?: string | null },
  ): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    
    const client = await this.squareClient.forOrg(orgId);

    const needsCatalogUpdate = data.name !== undefined || data.description !== undefined || data.priceCents !== undefined;

    if (needsCatalogUpdate) {
      // Fetch current item for version (optimistic locking)
      const current = await client.catalog.object.get({ objectId: squareItemId });
      const currentItem = asItem(current.object);
      if (!currentItem) throw new NotFoundException('Item not found in Square');

      const updatedVariations = currentItem.itemData?.variations?.map((v) => {
        const variation = asVariation(v);
        if (!variation) return v;
        return {
          ...variation,
          type: 'ITEM_VARIATION' as const,
          itemVariationData: {
            ...variation.itemVariationData,
            ...(data.priceCents !== undefined
              ? { pricingType: 'FIXED_PRICING' as const, priceMoney: { amount: BigInt(data.priceCents), currency: 'USD' as const } }
              : {}),
          },
        };
      });

      await client.catalog.object.upsert({
        idempotencyKey: uuidv4(),
        object: {
          type: 'ITEM',
          id: currentItem.id,
          version: currentItem.version,
          itemData: {
            ...currentItem.itemData,
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.description !== undefined ? { description: data.description ?? undefined } : {}),
            variations: updatedVariations,
          },
        },
      });
    }

    // Quantity change → physical count + update originalQuantity locally
    if (data.quantity !== undefined) {
      const assignment = await this.prisma.swapItemSeller.findUnique({
        where: { swapId_squareItemId: { swapId, squareItemId } },
      });
      if (assignment) {
        await client.inventory.batchCreateChanges({
          idempotencyKey: uuidv4(),
          changes: [
            {
              type: 'PHYSICAL_COUNT',
              physicalCount: {
                catalogObjectId: assignment.squareVariationId,
                state: 'IN_STOCK',
                locationId: swap.locationId,
                quantity: String(data.quantity),
                occurredAt: new Date().toISOString(),
              },
            },
          ],
        });
        await this.prisma.swapItemSeller.update({
          where: { id: assignment.id },
          data: { originalQuantity: data.quantity },
        });
      }
    }

    // Seller assignment change
    if (data.sellerId !== undefined) {
      if (data.sellerId === null) {
        await this.prisma.swapItemSeller.deleteMany({ where: { swapId, squareItemId } });
      } else {
        await this.sellerService.findOrThrow(orgId, data.sellerId);
        const existing = await this.prisma.swapItemSeller.findUnique({
          where: { swapId_squareItemId: { swapId, squareItemId } },
        });

        let squareVariationId = existing?.squareVariationId;
        if (!squareVariationId) {
          const objRes = await client.catalog.object.get({ objectId: squareItemId });
          squareVariationId = asItem(objRes.object)?.itemData?.variations?.[0]?.id;
        }

        if (existing) {
          await this.prisma.swapItemSeller.update({ where: { id: existing.id }, data: { sellerId: data.sellerId } });
        } else if (squareVariationId) {
          const inventoryMap = await this.fetchInventoryMap(client, [squareVariationId], swap.locationId);
          await this.prisma.swapItemSeller.create({
            data: {
              id: createId(),
              swapId,
              sellerId: data.sellerId,
              squareItemId,
              squareVariationId,
              originalQuantity: inventoryMap.get(squareVariationId) ?? 0,
            },
          });
        }
      }
    }

    return this.get(orgId, swapId, squareItemId);
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  async remove(orgId: string, swapId: string, squareItemId: string): Promise<void> {
    await this.findSwapOrThrow(orgId, swapId);
    const client = await this.squareClient.forOrg(orgId);
    await client.catalog.object.delete({ objectId: squareItemId });
    await this.prisma.swapItemSeller.deleteMany({ where: { swapId, squareItemId } });
  }

  // ─── Seller assignment (standalone endpoints) ─────────────────────────────

  async assignSeller(orgId: string, swapId: string, squareItemId: string, sellerId: string): Promise<void> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    await this.sellerService.findOrThrow(orgId, sellerId);
    const client = await this.squareClient.forOrg(orgId);
    

    const objRes = await client.catalog.object.get({ objectId: squareItemId });
    const squareVariationId = asItem(objRes.object)?.itemData?.variations?.[0]?.id;
    if (!squareVariationId) throw new NotFoundException('Item or variation not found in Square');

    const inventoryMap = await this.fetchInventoryMap(client, [squareVariationId], swap.locationId);

    await this.prisma.swapItemSeller.upsert({
      where: { swapId_squareItemId: { swapId, squareItemId } },
      update: { sellerId },
      create: {
        id: createId(),
        swapId,
        sellerId,
        squareItemId,
        squareVariationId,
        originalQuantity: inventoryMap.get(squareVariationId) ?? 0,
      },
    });
  }

  async unassignSeller(orgId: string, swapId: string, squareItemId: string): Promise<void> {
    await this.findSwapOrThrow(orgId, swapId);
    await this.prisma.swapItemSeller.deleteMany({ where: { swapId, squareItemId } });
  }

  // ─── Photos ───────────────────────────────────────────────────────────────

  async uploadImage(
    orgId: string,
    swapId: string,
    squareItemId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
  ): Promise<{ imageId: string; imageUrl: string | undefined }> {
    await this.findSwapOrThrow(orgId, swapId);
    const client = await this.squareClient.forOrg(orgId);

    const blob = new Blob([file.buffer], { type: file.mimetype });

    const res = await client.catalog.images.create({
      request: {
        idempotencyKey: uuidv4(),
        objectId: squareItemId,
        image: {
          type: 'IMAGE',
          id: '#image',
          imageData: { name: file.originalname },
        },
      },
      imageFile: blob,
    });

    const imageId = res.image?.id;
    if (!imageId) throw new BadRequestException('Square did not return an image ID');

    const imageUrl =
      res.image?.type === 'IMAGE' ? ((res.image as Square.CatalogObject.Image).imageData?.url ?? undefined) : undefined;

    return { imageId, imageUrl };
  }

  async deleteImage(orgId: string, swapId: string, squareItemId: string, imageId: string): Promise<void> {
    await this.findSwapOrThrow(orgId, swapId);
    const client = await this.squareClient.forOrg(orgId);

    // Verify the image is attached to this item before deleting
    const objRes = await client.catalog.object.get({ objectId: squareItemId });
    const item = asItem(objRes.object);
    if (!item) throw new NotFoundException('Item not found in Square');

    const isAttached = item.itemData?.imageIds?.includes(imageId);
    if (!isAttached) throw new NotFoundException('Image not found on this item');

    await client.catalog.object.delete({ objectId: imageId });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async findSwapOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId } });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  private async fetchInventoryMap(
    client: Awaited<ReturnType<SquareClientService['forOrg']>>,
    variationIds: string[],
    locationId: string,
  ): Promise<Map<string, number>> {
    if (variationIds.length === 0) return new Map();

    const page = await client.inventory.batchGetCounts({
      catalogObjectIds: variationIds,
      locationIds: [locationId],
    });

    const map = new Map<string, number>();
    for (const count of page.data) {
      if (count.state === 'IN_STOCK' && count.catalogObjectId && count.quantity) {
        map.set(count.catalogObjectId, Math.floor(parseFloat(count.quantity)));
      }
    }
    return map;
  }
}

