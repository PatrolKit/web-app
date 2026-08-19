import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { SquareClient, SquareError } from 'square';
import { SquareClientService } from '../square-client.service';
import { PosAdapterFactory, type IPosAdapter, type PosItemSync } from './pos.adapter';
import type { Square } from 'square';

function isSquareMissingReferenceError(err: unknown): boolean {
  if (!(err instanceof SquareError)) return false;
  return err.errors.some((e) =>
    e.code === 'NOT_FOUND' || e.code === 'INVALID_REFERENCE' || e.category === 'INVALID_REQUEST_ERROR',
  );
}

function asItem(obj: Square.CatalogObject | undefined | null) {
  if (obj?.type === 'ITEM') return obj as Square.CatalogObject.Item;
  return null;
}

class SquarePosAdapter implements IPosAdapter {
  constructor(private readonly client: SquareClient) {}

  private async findOrCreatePatrolKitCategory(): Promise<string> {
    const page = await this.client.catalog.list({ types: 'CATEGORY' });
    for await (const obj of page) {
      if (obj.type === 'CATEGORY' && (obj as any).categoryData?.name === 'PatrolKit') {
        return obj.id as string;
      }
    }
    const res = await this.client.catalog.object.upsert({
      idempotencyKey: uuidv4(),
      object: {
        type: 'CATEGORY',
        id: '#patrolkit',
        categoryData: { name: 'PatrolKit', isTopLevel: true },
      },
    });
    const id = res.catalogObject?.id;
    if (!id) throw new Error('Square did not return a category ID for PatrolKit');
    return id;
  }

  async upsertCategory(name: string): Promise<string> {
    const parentId = await this.findOrCreatePatrolKitCategory();
    const res = await this.client.catalog.object.upsert({
      idempotencyKey: uuidv4(),
      object: { type: 'CATEGORY', id: '#category', categoryData: { name, parentCategory: { id: parentId } } },
    });
    const id = res.catalogObject?.id;
    if (!id) throw new Error('Square did not return a category ID');
    return id;
  }

  private async doItemUpsert(item: PosItemSync, categoryId: string, existingVersion?: bigint) {
    return this.client.catalog.object.upsert({
      idempotencyKey: uuidv4(),
      object: {
        type: 'ITEM',
        id: item.posItemId ?? '#item',
        ...(existingVersion !== undefined ? { version: existingVersion } : {}),
        itemData: {
          name: item.name,
          description: item.description,
          // categories replaces the deprecated categoryId (deprecated since 2023-12-13)
          categories: [{ id: categoryId }],
          variations: [
            {
              type: 'ITEM_VARIATION',
              id: item.posVariationId ?? '#variation',
              itemVariationData: {
                name: 'Regular',
                sku: item.sku,
                pricingType: 'FIXED_PRICING',
                priceMoney: { amount: BigInt(item.priceCents), currency: 'USD' as const },
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
  }

  async syncItem(item: PosItemSync, locationId: string, initialQuantity: number): Promise<{ posItemId: string; posVariationId: string; resolvedCategoryId: string }> {
    let existingVersion: bigint | undefined;
    if (item.posItemId) {
      const current = await this.client.catalog.object.get({ objectId: item.posItemId });
      existingVersion = current.object?.version;
    }

    let resolvedCategoryId = item.categoryId;
    let upsertRes = await this.doItemUpsert(item, resolvedCategoryId, existingVersion).catch(async (err) => {
      if (err instanceof SquareError) {
        console.error('[Square] catalog upsert error — codes:', err.errors.map((e) => `${e.code}/${e.category}`).join(', '));
      }
      // If Square rejects the category reference, recreate the category and retry once.
      if (isSquareMissingReferenceError(err)) {
        console.warn('[Square] Category missing, recreating for swap category:', item.categoryId);
        resolvedCategoryId = await this.upsertCategory(item.categoryName);
        return this.doItemUpsert(item, resolvedCategoryId, existingVersion);
      }
      throw err;
    });

    const posItemId = upsertRes.catalogObject?.id;
    if (!posItemId) throw new Error('Square did not return an item ID');

    const idMappings = upsertRes.idMappings ?? [];
    const posVariationId =
      idMappings.find((m) => m.clientObjectId === '#variation')?.objectId ??
      item.posVariationId ??
      asItem(upsertRes.catalogObject)?.itemData?.variations?.[0]?.id;

    if (!posVariationId) throw new Error('Square did not return a variation ID');

    // Set initial inventory for new items separately — a failure here must not
    // prevent us from returning the catalog IDs (we still want squareItemId stored).
    if (!item.posItemId) {
      await this.setInitialInventory(posVariationId, locationId, initialQuantity)
        .catch((err) => console.error('[Square] setInitialInventory failed:', err));
    }

    return { posItemId, posVariationId, resolvedCategoryId };
  }

  async deleteItem(posItemId: string): Promise<void> {
    await this.client.catalog.object.delete({ objectId: posItemId });
  }

  async uploadImage(posItemId: string, buffer: Buffer, mimeType: string): Promise<{ posImageId: string; imageUrl: string }> {
    const blob = new Blob([buffer], { type: mimeType });
    const res = await this.client.catalog.images.create({
      request: {
        idempotencyKey: uuidv4(),
        objectId: posItemId,
        image: { type: 'IMAGE', id: '#image', imageData: { name: 'item-photo' } },
      },
      imageFile: blob,
    });
    const posImageId = res.image?.id;
    if (!posImageId) throw new Error('Square did not return an image ID');
    const imageUrl =
      res.image?.type === 'IMAGE'
        ? ((res.image as Square.CatalogObject.Image).imageData?.url ?? undefined)
        : undefined;
    return { posImageId, imageUrl: imageUrl ?? '' };
  }

  async deleteImage(posImageId: string): Promise<void> {
    await this.client.catalog.object.delete({ objectId: posImageId });
  }

  async getInventoryCounts(variationIds: string[], locationId: string): Promise<Map<string, number>> {
    if (variationIds.length === 0) return new Map();
    const page = await this.client.inventory.batchGetCounts({
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

  async setInitialInventory(variationId: string, locationId: string, quantity: number): Promise<void> {
    const res = await this.client.inventory.batchCreateChanges({
      idempotencyKey: uuidv4(),
      changes: [{
        type: 'ADJUSTMENT',
        adjustment: {
          catalogObjectId: variationId,
          fromState: 'NONE',
          fromLocationId: locationId,
          toState: 'IN_STOCK',
          toLocationId: locationId,
          quantity: String(quantity),
          occurredAt: new Date().toISOString(),
        },
      }],
    });
    if (res.errors?.length) {
      throw new Error(`Square inventory errors: ${res.errors.map((e) => `${e.code}: ${e.detail}`).join(', ')}`);
    }
  }

  async setInventoryPhysicalCount(variationId: string, locationId: string, quantity: number): Promise<void> {
    await this.client.inventory.batchCreateChanges({
      idempotencyKey: uuidv4(),
      changes: [{
        type: 'PHYSICAL_COUNT',
        physicalCount: {
          catalogObjectId: variationId,
          state: 'IN_STOCK',
          locationId,
          quantity: String(quantity),
          occurredAt: new Date().toISOString(),
        },
      }],
    });
  }
}

@Injectable()
export class SquarePosAdapterFactory extends PosAdapterFactory {
  constructor(private readonly squareClient: SquareClientService) {
    super();
  }

  async forOrg(orgId: string): Promise<IPosAdapter | null> {
    try {
      const client = await this.squareClient.forOrg(orgId);
      return new SquarePosAdapter(client);
    } catch {
      return null;
    }
  }
}

