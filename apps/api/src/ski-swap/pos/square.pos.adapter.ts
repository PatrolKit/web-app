import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { SquareClient, SquareError } from 'square';
import { SquareClientService } from '../square-client.service';
import { PosAdapterFactory, type IPosAdapter, type PosItemSync } from './pos.adapter';
import type { Square } from 'square';
import type { PosCatalogItem, PosSaleLine, PosUpsertResult } from './pos.adapter';
import { withRateLimitRetry } from './square-retry';

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
      object: itemObject(item, categoryId, item.posItemId ?? '#item', item.posVariationId ?? '#variation', existingVersion),
    });
  }

  /**
   * Many new items in as few calls as Square allows (Plan 38): a block of
   * issued tickets is hundreds at once, and one call each was minutes.
   *
   * 500 items to a batch, each carrying its variation, so a batch stays under
   * Square's 1,000 objects. Stock goes on in calls of 100, Square's limit. A
   * stock call that fails is retried once and then logged rather than thrown:
   * the catalogue ids must still come back, or a retry would create every
   * item twice. An item left with no count is repaired by its next single
   * sync, which sets a count where Square has none.
   */
  async syncNewItems(items: PosItemSync[], locationId: string, initialQuantity: number) {
    const ids: { posItemId: string; posVariationId: string }[] = [];
    let categoryId = items[0]?.categoryId ?? '';
    const categoryName = items[0]?.categoryName ?? '';

    for (let start = 0; start < items.length; start += 500) {
      const slice = items.slice(start, start + 500);
      // One already in Square under its SKU is linked and updated, not
      // created again (Plan 47): a crash mid-create, or an older orphan.
      const existing = await this.activeBySku(categoryId, slice.map((i) => i.sku));
      const chunk = slice.map((item) => {
        const found = existing.get(item.sku);
        return found ? { ...item, posItemId: found.itemId, posVariationId: found.variationId } : item;
      });
      const request = (category: string): Square.BatchUpsertCatalogObjectsRequest => ({
        idempotencyKey: uuidv4(),
        batches: [{ objects: chunk.map((item, i) => {
          const found = existing.get(item.sku);
          return found
            ? itemObject(item, category, found.itemId, found.variationId, found.version)
            : itemObject(item, category, `#item${i}`, `#variation${i}`);
        }) }],
      });
      const res = await this.client.catalog.batchUpsert(request(categoryId)).catch(async (err) => {
        if (!isSquareMissingReferenceError(err)) throw err;
        console.warn('[Square] Category missing, recreating for swap category:', categoryId);
        categoryId = await this.upsertCategory(categoryName);
        return this.client.catalog.batchUpsert(request(categoryId));
      });
      const mapped = new Map((res.idMappings ?? []).map((m) => [m.clientObjectId, m.objectId]));
      const chunkIds = chunk.map((item, i) => {
        const posItemId = item.posItemId ?? mapped.get(`#item${i}`);
        const posVariationId = item.posVariationId ?? mapped.get(`#variation${i}`);
        if (!posItemId || !posVariationId) throw new Error('Square did not return ids for every item in a batch');
        return { posItemId, posVariationId };
      });
      ids.push(...chunkIds);
      // Stock for the ones just created; a linked one already has its count.
      await this.addStartingStock(chunkIds.filter((_, i) => !chunk[i].posItemId).map((x) => x.posVariationId), locationId, initialQuantity);
    }

    return { ids, resolvedCategoryId: categoryId };
  }

  /**
   * New items' starting stock, 100 to a call (Square's limit). A call that
   * fails is retried once and then logged rather than thrown: the catalogue
   * ids must still come back. An item left with no count is repaired by its
   * next single sync.
   */
  private async addStartingStock(variationIds: string[], locationId: string, quantity: number): Promise<void> {
    for (let at = 0; at < variationIds.length; at += 100) {
      const variations = variationIds.slice(at, at + 100);
      const stock = () => this.client.inventory.batchCreateChanges({
        idempotencyKey: uuidv4(),
        changes: variations.map((catalogObjectId) => ({
          type: 'ADJUSTMENT' as const,
          adjustment: {
            catalogObjectId,
            fromState: 'NONE' as const,
            fromLocationId: locationId,
            toState: 'IN_STOCK' as const,
            toLocationId: locationId,
            quantity: String(quantity),
            occurredAt: new Date().toISOString(),
          },
        })),
      });
      await stock().catch(() => stock()).catch((err) => console.error('[Square] batch stock failed:', err));
    }
  }

  // ─── Swap diagnostics (Plan 41) ─────────────────────────────────────────────

  async listCategoryItems(categoryId: string, onPage?: (soFar: number) => void): Promise<PosCatalogItem[]> {
    const out: PosCatalogItem[] = [];
    let cursor: string | undefined;
    do {
      const res = await withRateLimitRetry(() =>
        this.client.catalog.searchItems({ categoryIds: [categoryId], limit: 100, cursor }));
      for (const obj of res.items ?? []) out.push(...catalogEntries(obj));
      cursor = res.cursor;
      onPage?.(out.length);
    } while (cursor);
    return out;
  }

  /**
   * The active item in the category carrying each SKU, for linking instead
   * of creating (Plan 47). Archived ones never count: they can't be sold
   * through a link, and Square still scans them, so they're Catalog check's to
   * delete. Two active ones for a SKU link the same one every time (the
   * lower id), and are logged: Catalog check reports the other.
   */
  private async activeBySku(categoryId: string, skus: string[]): Promise<Map<string, { itemId: string; variationId: string; version?: bigint }>> {
    const wanted = new Set(skus.filter(Boolean));
    const out = new Map<string, { itemId: string; variationId: string; version?: bigint }>();
    if (!categoryId || wanted.size === 0) return out;
    const list = [...wanted];
    for (let at = 0; at < list.length; at += 100) {
      let cursor: string | undefined;
      do {
        const res = await withRateLimitRetry(() => this.client.catalog.search({
          objectTypes: ['ITEM_VARIATION'],
          includeRelatedObjects: true,
          limit: 1000,
          cursor,
          query: { setQuery: { attributeName: 'sku', attributeValues: list.slice(at, at + 100) } },
        }));
        const parents = new Map((res.relatedObjects ?? []).filter((o) => o.type === 'ITEM' && o.id).map((o) => [o.id!, o]));
        for (const v of res.objects ?? []) {
          const vd = v.type === 'ITEM_VARIATION' ? (v as Square.CatalogObject.ItemVariation).itemVariationData : null;
          const sku = vd?.sku;
          if (!v.id || v.isDeleted || !sku || !wanted.has(sku) || !vd?.itemId) continue;
          const parent = parents.get(vd.itemId);
          const data = asItem(parent)?.itemData;
          if (!parent || parent.isDeleted || !data || data.isArchived || !inCategory(parent, categoryId)) continue;
          const candidate = { itemId: parent.id!, variationId: v.id, version: parent.version };
          const seen = out.get(sku);
          if (seen && seen.itemId !== candidate.itemId) {
            console.warn('[Square] SKU on more than one active item; linking one, Catalog check reports the other:', sku);
            if (candidate.itemId > seen.itemId) continue;
          }
          out.set(sku, candidate);
        }
        cursor = res.cursor;
      } while (cursor);
    }
    return out;
  }

  /** These items, with any that have no stored id linked to the one Square already has under its SKU. */
  private async adoptBySku(items: PosItemSync[], categoryId: string): Promise<PosItemSync[]> {
    const missing = items.filter((i) => !i.posItemId).map((i) => i.sku);
    if (missing.length === 0) return items;
    const existing = await this.activeBySku(categoryId, missing);
    return items.map((i) => {
      const found = i.posItemId ? undefined : existing.get(i.sku);
      return found ? { ...i, posItemId: found.itemId, posVariationId: found.variationId } : i;
    });
  }

  /**
   * Variations by SKU, with their items, then only the items in the category.
   * 100 SKUs to a search; Square answers up to 1,000 objects a page.
   */
  async itemsBySku(categoryId: string, skus: string[]): Promise<PosCatalogItem[]> {
    const wanted = new Set(skus);
    const parents = new Map<string, Square.CatalogObject>();
    for (let at = 0; at < skus.length; at += 100) {
      let cursor: string | undefined;
      do {
        const res = await withRateLimitRetry(() => this.client.catalog.search({
          objectTypes: ['ITEM_VARIATION'],
          includeRelatedObjects: true,
          limit: 1000,
          cursor,
          query: { setQuery: { attributeName: 'sku', attributeValues: skus.slice(at, at + 100) } },
        }));
        for (const obj of res.relatedObjects ?? []) if (obj.type === 'ITEM' && obj.id) parents.set(obj.id, obj);
        cursor = res.cursor;
      } while (cursor);
    }
    return [...parents.values()]
      .filter((obj) => inCategory(obj, categoryId))
      .flatMap((obj) => catalogEntries(obj))
      .filter((entry) => wanted.has(entry.sku));
  }

  /**
   * Many items written in as few calls as Square allows: existing ones at the
   * version Square holds now, read just before, so a write isn't refused for
   * being stale; new ones with their starting stock. One whose stored id
   * Square no longer has is created afresh, as `syncItem` does.
   *
   * A batch refused for a version mismatch (changed in the meantime) is tried
   * once more at fresh versions. A batch that still fails is reported on its
   * items, and the other batches stand.
   */
  async upsertItems(input: PosItemSync[], locationId: string, initialQuantity: number) {
    const results: PosUpsertResult[] = new Array(input.length);
    let categoryId = input[0]?.categoryId ?? '';
    // One with no stored id that Square already has under its SKU is linked
    // and updated, not created again (Plan 47).
    const items = await this.adoptBySku(input, categoryId);
    const categoryName = items[0]?.categoryName ?? '';

    for (let start = 0; start < items.length; start += 500) {
      const chunk = items.slice(start, start + 500);
      const write = async (category: string) => {
        const versions = await this.versionsOf(
          chunk.flatMap((item) => (item.posItemId && item.posVariationId ? [item.posItemId] : [])),
        );
        const objects = chunk.map((item, i) => {
          const version = item.posItemId ? versions.get(item.posItemId) : undefined;
          return version !== undefined
            ? itemObject(item, category, item.posItemId!, item.posVariationId!, version)
            : itemObject(item, category, `#item${i}`, `#variation${i}`);
        });
        const res = await withRateLimitRetry(() => this.client.catalog.batchUpsert({
          idempotencyKey: uuidv4(),
          batches: [{ objects }],
        }));
        return { res, objects };
      };

      try {
        const { res, objects } = await write(categoryId).catch(async (err: unknown) => {
          if (err instanceof SquareError && err.errors.some((e) => e.code === 'VERSION_MISMATCH')) {
            return write(categoryId);
          }
          if (!isSquareMissingReferenceError(err)) throw err;
          console.warn('[Square] Category missing, recreating for swap category:', categoryId);
          categoryId = await this.upsertCategory(categoryName);
          return write(categoryId);
        });
        const mapped = new Map((res.idMappings ?? []).map((m) => [m.clientObjectId, m.objectId]));
        const created: string[] = [];
        objects.forEach((obj, i) => {
          const fresh = (obj.id ?? '#').startsWith('#');
          const posItemId = fresh ? mapped.get(`#item${i}`) : obj.id;
          const posVariationId = fresh ? mapped.get(`#variation${i}`) : chunk[i].posVariationId;
          results[start + i] = posItemId && posVariationId
            ? { posItemId, posVariationId }
            : { error: 'Square did not return ids for this item' };
          if (fresh && posVariationId) created.push(posVariationId);
        });
        await this.addStartingStock(created, locationId, initialQuantity);
      } catch (err) {
        const message = err instanceof SquareError
          ? err.errors.map((e) => e.detail ?? e.code).join('; ') || err.message
          : err instanceof Error ? err.message : String(err);
        chunk.forEach((_, i) => { results[start + i] = { error: message }; });
      }
    }

    return { results, resolvedCategoryId: categoryId };
  }

  /** The current version of each item Square still has; absent when it doesn't. */
  private async versionsOf(itemIds: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (let at = 0; at < itemIds.length; at += 1000) {
      const res = await withRateLimitRetry(() =>
        this.client.catalog.batchGet({ objectIds: itemIds.slice(at, at + 1000), includeRelatedObjects: false }));
      for (const obj of res.objects ?? []) {
        if (obj.type === 'ITEM' && obj.id && !obj.isDeleted && obj.version !== undefined) out.set(obj.id, obj.version);
      }
    }
    return out;
  }

  /** Many items out of the catalogue at once, 200 to a call (Square's limit). */
  async deleteItems(posItemIds: string[]): Promise<void> {
    for (let at = 0; at < posItemIds.length; at += 200) {
      await this.client.catalog.batchDelete({ objectIds: posItemIds.slice(at, at + 200) });
    }
  }

  async syncItem(input: PosItemSync, locationId: string, initialQuantity: number): Promise<{ posItemId: string; posVariationId: string; resolvedCategoryId: string }> {
    let item = input;
    let existingVersion: bigint | undefined;
    if (item.posItemId) {
      const current = await this.client.catalog.object.get({ objectId: item.posItemId }).catch((err: unknown) => {
        // Gone from the catalogue — somebody tidied the Square dashboard, or
        // the org moved from sandbox to production and every stored id went
        // with it. Not an error to report forever: the item is created afresh,
        // and the caller stores the new ids over the dangling ones.
        if (err instanceof SquareError && err.errors.some((e) => e.code === 'NOT_FOUND')) return null;
        throw err;
      });
      if (current) {
        existingVersion = current.object?.version;
      } else {
        console.warn('[Square] stored item no longer exists, recreating:', item.posItemId);
        item = { ...item, posItemId: undefined, posVariationId: undefined };
      }
    }
    if (!item.posItemId) {
      // Already in Square under its SKU: link and update it rather than
      // create a second (Plan 47).
      const found = (await this.activeBySku(item.categoryId, [item.sku])).get(item.sku);
      if (found) {
        item = { ...item, posItemId: found.itemId, posVariationId: found.variationId };
        existingVersion = found.version;
      }
    }

    let resolvedCategoryId = item.categoryId;
    const upsertRes = await this.doItemUpsert(item, resolvedCategoryId, existingVersion).catch(async (err) => {
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
    //
    // And again for an existing item that has no count at all. The first
    // attempt can fail on its own — a wrong location, a variation Square has
    // not finished creating, a transient error — and since every later sync
    // took the update path, nothing ever came back for it: the item sat in the
    // catalogue with no stock and read as sold. A count of zero is a count;
    // only an absent one is retried.
    //
    // Only on Square's say-so. A read that fails says nothing about whether a
    // count exists, and resetting on it would restock an item that has sold.
    const needsCount = !item.posItemId || (await this.hasNoCount(posVariationId, locationId));
    if (needsCount) {
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

  /**
   * True only when Square answered and holds no count row of any state for
   * this variation — the one case where its stock was never set. A row with
   * quantity "0" is a row: the item sold out, and must not be restocked.
   * False on a failed read, because not knowing is not the same as absent.
   */
  private async hasNoCount(variationId: string, locationId: string): Promise<boolean> {
    try {
      const page = await this.client.inventory.batchGetCounts({
        catalogObjectIds: [variationId],
        locationIds: [locationId],
      });
      for await (const count of page) {
        if (count.catalogObjectId === variationId) return false;
      }
      return true;
    } catch (err) {
      console.error('[Square] could not read inventory before deciding to set it:', err);
      return false;
    }
  }

  /**
   * In-stock units per variation, 1,000 ids to a call (Square's limit): a
   * shop with more items than that was refused outright, and every caller
   * read its stock as unknown.
   */
  async getInventoryCounts(variationIds: string[], locationId: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (let at = 0; at < variationIds.length; at += 1000) {
      const page = await this.client.inventory.batchGetCounts({
        catalogObjectIds: variationIds.slice(at, at + 1000),
        locationIds: [locationId],
      });
      // Every page. `page.data` is the first one only, and anything past it read
      // as "no count" — which the caller turns into "sold" — on a swap large
      // enough to need a second page.
      for await (const count of page) {
        if (count.state === 'IN_STOCK' && count.catalogObjectId && count.quantity) {
          map.set(count.catalogObjectId, Math.floor(parseFloat(count.quantity)));
        }
      }
    }
    return map;
  }

  /**
   * Completed orders in a window, flattened to one entry per line item.
   *
   * Paged to the end rather than to the first cursor: a payout built from a
   * partial read underpays whoever fell off the last page, and nothing would
   * say so.
   *
   * `COMPLETED` only. An open or cancelled order has not taken anybody's money,
   * and paying on one would be paying for a sale that did not happen.
   */
  async listSales(locationId: string, from: Date, to: Date): Promise<PosSaleLine[]> {
    const lines: PosSaleLine[] = [];
    let cursor: string | undefined;

    do {
      const res = await this.client.orders.search({
        locationIds: [locationId],
        cursor,
        limit: 200,
        query: {
          filter: {
            stateFilter: { states: ['COMPLETED'] },
            dateTimeFilter: {
              closedAt: { startAt: from.toISOString(), endAt: to.toISOString() },
            },
          },
        },
      });
      if (res.errors?.length) {
        throw new Error(`Square order search failed: ${res.errors.map((e) => `${e.code}: ${e.detail}`).join(', ')}`);
      }

      for (const order of res.orders ?? []) {
        // `closedAt` is when the money was taken, which is the date a seller
        // would recognise. `createdAt` is when the cart was opened.
        const soldAt = new Date(order.closedAt ?? order.createdAt ?? Date.now());
        const refundedByLine = refundedQuantities(order);

        for (const line of order.lineItems ?? []) {
          // A line with no catalog object is something rung up by hand. It
          // cannot be matched to a seller's item, and the run reports those
          // rather than dropping them — see `PayoutRunService`.
          if (!line.catalogObjectId) continue;
          lines.push({
            orderId: order.id ?? '',
            variationId: line.catalogObjectId,
            quantity: Number(line.quantity ?? '0'),
            // `totalMoney` is after discounts, which is what the register took
            // and therefore what the org actually has.
            collectedCents: Number(line.totalMoney?.amount ?? 0n),
            unitPriceCents: line.basePriceMoney?.amount != null ? Number(line.basePriceMoney.amount) : null,
            refundedQuantity: refundedByLine.get(line.uid ?? '') ?? 0,
            soldAt,
          });
        }
      }
      cursor = res.cursor;
    } while (cursor);

    return lines;
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

/**
 * How much of each line came back, keyed by the line's uid.
 *
 * Square records a return as its own set of line items pointing at the ones
 * they reverse. A refunded quantity is not a sale, and counting it would pay a
 * seller for goods the buyer handed back.
 */
function refundedQuantities(order: Square.Order): Map<string, number> {
  const out = new Map<string, number>();
  for (const ret of order.returns ?? []) {
    for (const line of ret.returnLineItems ?? []) {
      const uid = line.sourceLineItemUid;
      if (!uid) continue;
      out.set(uid, (out.get(uid) ?? 0) + Number(line.quantity ?? '0'));
    }
  }
  return out;
}

/**
 * How a variation is priced in Square.
 *
 * A legacy ticket not yet priced (Plan 32) is `VARIABLE_PRICING` with no
 * amount: Square's "price is entered at the time of sale", so the register asks
 * the clerk for one when it's rung up. Once staff price it, the next sync makes
 * it fixed, as every other item is.
 */
export function variationPricing(priceCents: number | null) {
  return priceCents === null
    ? { pricingType: 'VARIABLE_PRICING' as const }
    : { pricingType: 'FIXED_PRICING' as const, priceMoney: { amount: BigInt(priceCents), currency: 'USD' as const } };
}

/** Whether a catalog item is in a category, in either of the ways Square records it. */
function inCategory(obj: Square.CatalogObject, categoryId: string): boolean {
  const data = asItem(obj)?.itemData;
  return !!data && (data.categoryId === categoryId || (data.categories ?? []).some((c) => c.id === categoryId));
}

/** A catalog item flattened to its variations, as the diagnostics compare them (Plan 41). */
export function catalogEntries(obj: Square.CatalogObject): PosCatalogItem[] {
  const item = asItem(obj);
  if (!item?.id || !item.itemData || item.isDeleted) return [];
  const data = item.itemData;
  const description = (data.description ?? data.descriptionPlaintext ?? '').trim();
  return (data.variations ?? []).flatMap((v) => {
    const vd = v.type === 'ITEM_VARIATION' ? (v as Square.CatalogObject.ItemVariation).itemVariationData : null;
    if (!v.id || !vd || v.isDeleted) return [];
    return [{
      itemId: item.id,
      variationId: v.id,
      sku: vd.sku ?? '',
      name: data.name ?? '',
      description: description || null,
      pricing: vd.pricingType === 'VARIABLE_PRICING' || vd.priceMoney?.amount == null
        ? { type: 'variable' as const }
        : { type: 'fixed' as const, cents: Number(vd.priceMoney.amount) },
      version: item.version !== undefined ? item.version.toString() : null,
      updatedAt: item.updatedAt ?? null,
    }];
  });
}

/** An item and its one variation, as the catalogue stores them. */
function itemObject(
  item: PosItemSync,
  categoryId: string,
  itemId: string,
  variationId: string,
  existingVersion?: bigint,
): Square.CatalogObject {
  return {
    type: 'ITEM',
    id: itemId,
    ...(existingVersion !== undefined ? { version: existingVersion } : {}),
    itemData: {
      name: item.name,
      description: item.description,
      // categories replaces the deprecated categoryId (deprecated since 2023-12-13)
      categories: [{ id: categoryId }],
      variations: [
        {
          type: 'ITEM_VARIATION',
          id: variationId,
          itemVariationData: {
            // The SKU, not "Regular": Square prints the variation's name on
            // the receipt line ("K2 Skis (73789)"), so a buyer's receipt says
            // which ticket each line was.
            name: item.sku,
            sku: item.sku,
            ...variationPricing(item.priceCents),
            stockable: true,
            trackInventory: true,
            inventoryAlertType: 'LOW_QUANTITY',
            inventoryAlertThreshold: BigInt(1),
          },
        },
      ],
    },
  } as Square.CatalogObject;
}
