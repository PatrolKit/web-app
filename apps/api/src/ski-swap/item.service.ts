import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory } from './pos/pos.adapter';
import type { IPosAdapter } from './pos/pos.adapter';
import { SellerService, SELLER_NAME_INCLUDE, sellerDisplayName, type SellerNameRow } from './seller.service';
import { S3Service } from './s3.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { SkuService } from './sku.service';
import { PrintQueueService } from './print-queue.service';
import { SkiSwapSettingsService } from './ski-swap-settings.service';
import { LegacyTicketService, ticketNumberOf } from './legacy-ticket.service';
import { createId } from '@paralleldrive/cuid2';
import sharp from 'sharp';
import type { ItemResponse } from '../contracts/ski-swap.contracts';

export interface ItemPhotoResponse { id: string; url: string; }

/**
 * Re-exported from the contract rather than declared again here. This file used
 * to carry its own structurally-identical copy, which is how a response and the
 * schema that documents it drift apart without anything failing to compile.
 */
export type { ItemResponse };

type SwapShape = { id: string; title: string; squareCategoryId: string; locationId: string; skuPrefix: string; skuCounter: number };

/** Keys are client-supplied, so they are only ever meaningful within one swap. */
function idempotencyScope(orgId: string, swapId: string): string {
  return `item-create:${orgId}:${swapId}`;
}

/** What a Square push did: landed, was not configured, or errored. */
export type PosSyncResult = 'synced' | 'skipped' | 'failed';

/** A collision on `@@unique([swapId, sku])` — one number, two items. */
function isDuplicateSku(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

@Injectable()
export class ItemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
    private readonly sellerService: SellerService,
    private readonly s3: S3Service,
    private readonly idempotency: IdempotencyService,
    private readonly skuService: SkuService,
    private readonly printQueue: PrintQueueService,
    private readonly settings: SkiSwapSettingsService,
    private readonly tickets: LegacyTicketService,
  ) {}

  async list(orgId: string, swapId: string, opts: { query?: string; sellerId?: string; skip?: number; take?: number; updatedSince?: string; consigned?: boolean }): Promise<{ items: ItemResponse[]; total: number }> {
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
      // What a staff member still has to look through, or what has been taken.
      ...(opts.consigned === undefined
        ? {}
        : opts.consigned
          ? { consignedAt: { not: null } }
          : { consignedAt: null }),
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

  /**
   * Creates an item that may have been checked in at a station.
   *
   * The staff path, which is the one that can print for itself: a client that
   * printed a tag over Bluetooth says so, and no job is queued. Enqueueing
   * anyway would put a second tag through the station's bridge — and for an
   * item held offline and synced later, the first one is already on the ski.
   */
  async createAtStation(
    orgId: string,
    swapId: string,
    data: {
      name: string; description?: string; priceCents: number; quantity: number;
      sellerId?: string; donateProceeds?: boolean; sku?: string;
      stationId?: string; alreadyPrinted?: boolean;
      /**
       * The seller entered this themselves, with no staff present.
       *
       * Only these can be made to wait for a scan — anything a staff member
       * typed was already in somebody's hands, and a second handling buys
       * nothing. Waiting also needs a station: a business seller listing stock
       * from their own desk entered it themselves too, and there is nobody at
       * a table to come and look through a box that has not arrived.
       */
      selfService?: boolean;
    },
    idempotencyKey?: string,
  ): Promise<ItemResponse> {
    const station = data.stationId
      ? await this.prisma.checkinStation.findFirst({
          where: { id: data.stationId, orgId, deletedAt: null },
          select: { id: true, code: true, bridgeDeviceId: true },
        })
      : null;
    if (data.stationId && !station) throw new NotFoundException('Station not found');

    /**
     * A loose ticket must not be one already issued to a shop.
     *
     * There is one stockpile, spent two ways: blocks handed to a business
     * seller, and single tickets given out at the counter. Nothing physically
     * stops the wrong ticket coming off the wrong pile, and taking it here
     * would quietly hand a shop's number to somebody else — discovered when
     * the shop enters theirs and is refused for a duplicate they never made.
     *
     * A business seller entering their own is the ordinary case and passes:
     * the block is theirs.
     */
    if (data.sku) {
      const holder = await this.tickets.holderOf(swapId, data.sku);
      if (holder && holder.sellerId !== data.sellerId) {
        throw new ConflictException(
          `Ticket ${data.sku} is part of a block issued to ${holder.name}.`,
        );
      }
    }

    // Read once, here, and answered onto the row. Nothing consults it again.
    const awaitsConsignment =
      data.selfService && station
        ? (await this.settings.get(orgId)).requireConsignmentScan
        : false;

    const item = await this.create(
      orgId,
      swapId,
      {
        ...data,
        stationCode: station?.code ?? null,
        // At a station the person is standing there watching; Square waits for
        // the batch at finish.
        deferPos: !!station,
        awaitsConsignment,
      },
      idempotencyKey,
    );

    // Nothing to queue when the tag is already on the item, and nothing to queue
    // through a station that has no bridge — the client printed it itself.
    if (station?.bridgeDeviceId && !data.alreadyPrinted) {
      const { labelsPerItem } = await this.settings.get(orgId);
      await this.printQueue.enqueueItemTags({
        orgId,
        stationId: station.id,
        swapId,
        sellerId: data.sellerId ?? null,
        itemId: item.id,
        count: labelsPerItem,
      });
    } else if (data.alreadyPrinted) {
      await this.prisma.swapItem.update({
        where: { id: item.id },
        data: { hasPrintedTag: true },
      });
      // The response was built before that write. Without this the client is
      // handed `hasPrintedTag: false` for an item whose tag is demonstrably
      // already on it — and offers a reprint of a ticket that came out of a
      // box, which there is no way to reprint.
      item.hasPrintedTag = true;
    }

    return item;
  }

  /**
   * Creates an item.
   *
   * `deferPos` is what makes self-service check-in fast enough to stand at: a
   * save otherwise awaits two Square round-trips on venue wifi, inside an
   * interaction the seller is watching. Deferred, the push happens in a batch at
   * finish (D17) — and an item that is not on the floor yet cannot be sold at
   * the register in the meantime.
   */
  async create(orgId: string, swapId: string, data: { name: string; description?: string; priceCents: number; quantity: number; sellerId?: string; donateProceeds?: boolean; sku?: string; stationCode?: string | null; deferPos?: boolean; awaitsConsignment?: boolean }, idempotencyKey?: string): Promise<ItemResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(idempotencyScope(orgId, swapId), idempotencyKey);
      if (cached) return cached as unknown as ItemResponse;
    }

    const swap = await this.findSwapOrThrow(orgId, swapId);
    if (data.sellerId) await this.sellerService.findOrThrow(orgId, data.sellerId);

    let sku: string;
    if (data.sku) {
      sku = data.sku;
    } else {
      sku = await this.skuService.next(swapId, data.stationCode ?? null);
    }

    const item = await this.prisma.swapItem.create({
      data: {
        id: createId(), swapId, orgId, sellerId: data.sellerId ?? null,
        name: data.name, description: data.description ?? null,
        priceCents: data.priceCents, sku, originalQuantity: data.quantity,
        donateProceeds: data.donateProceeds ?? false,
        /**
         * The setting is read by the caller and answered here, once. An item
         * that must wait carries null; everything else is consigned at birth,
         * which is what lets the org toggle change later without moving
         * anything already on the floor.
         */
        consignedAt: data.awaitsConsignment ? null : new Date(),
      },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: true },
    }).catch((err: unknown) => {
      /**
       * `@@unique([swapId, sku])` is the only thing standing between one
       * physical ticket and two items, and it was reaching the client as a bare
       * 500. Scanning a ticket that is already on something is the likeliest
       * thing to happen at a counter — a re-scan, or two stations working the
       * same pile — and a volunteer holding an iPad needs to be told which
       * ticket, not "Internal server error".
       *
       * Caught rather than checked beforehand: a look-then-insert leaves a gap
       * two stations can both pass through, and the index does not.
       */
      if (isDuplicateSku(err)) {
        throw new ConflictException(
          ticketNumberOf(sku) !== null
            ? `Ticket ${sku} is already on another item.`
            : `${sku} is already in use in this swap.`,
        );
      }
      throw err;
    });

    // Square is where "on sale" lives, so an item waiting to be accepted must
    // not reach it — not priced at zero, not flagged: absent.
    if (!data.deferPos && !data.awaitsConsignment) await this.syncItemToPos(orgId, swap, item);

    const refreshed = data.deferPos
      ? item
      : await this.prisma.swapItem.findUniqueOrThrow({ where: { id: item.id }, include: { seller: { include: SELLER_NAME_INCLUDE }, photos: true } });
    // Inventory is a Square read, so it goes with the write it belongs to.
    const inventoryMap = data.deferPos
      ? new Map<string, number>()
      : await this.fetchInventoryMap(orgId, swap, [refreshed]);
    const response = this.toResponse(refreshed, inventoryMap);

    if (idempotencyKey) {
      await this.idempotency.save(
        idempotencyScope(orgId, swapId),
        idempotencyKey,
        response as unknown as Record<string, unknown>,
      );
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

  // ─── Consignment ───────────────────────────────────────────────────────────

  /**
   * Finds an item by the number on its tag, exactly.
   *
   * `list`'s search matches `sku` with `contains`, which is right for someone
   * typing into a box and wrong for a scanner: `67169` would also match
   * `671690`, and a staff member accepting a pile would silently accept the
   * wrong thing.
   */
  async findBySku(orgId: string, swapId: string, sku: string): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const tag = sku.trim();
    const item = await this.prisma.swapItem.findFirst({
      where: { orgId, swapId, sku: tag },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
    });
    if (!item) throw new NotFoundException(`No item in this swap has tag ${tag}.`);
    const inventoryMap = await this.fetchInventoryMap(orgId, swap, [item]);
    return this.toResponse(item, inventoryMap);
  }

  /**
   * Accepts an item onto the floor, and puts it in Square.
   *
   * Idempotent on purpose: a scanner double-reads a barcode constantly, and the
   * second read of a tag a staff member has just accepted must not be an error
   * they have to think about.
   */
  async consign(
    orgId: string,
    swapId: string,
    itemId: string,
    actorId: string | null,
  ): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const existing = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId, swapId } });
    if (!existing) throw new NotFoundException('Item not found');

    if (existing.consignedAt === null) {
      const accepted = await this.prisma.swapItem.update({
        where: { id: itemId },
        data: { consignedAt: new Date(), consignedBy: actorId },
      });
      // The item reaches the catalogue exactly here — being accepted and being
      // sellable are the same event.
      await this.syncItemToPos(orgId, swap, accepted);
    }

    const item = await this.prisma.swapItem.findUniqueOrThrow({
      where: { id: itemId },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
    });
    const inventoryMap = await this.fetchInventoryMap(orgId, swap, [item]);
    return this.toResponse(item, inventoryMap);
  }

  /**
   * Pushes one already-saved item to Square. The batched half of D17 — check-in
   * defers every push to finish, and this is what finish calls.
   */
  async syncToPos(orgId: string, swapId: string, itemId: string): Promise<PosSyncResult> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, swapId } });
    return this.syncItemToPos(orgId, swap, item);
  }

  /**
   * Swallows Square failures, and reports which of the three things happened.
   * Save paths ignore the result — a POS outage must not fail a save — but the
   * batched push at check-in finish tells the seller what actually landed, and
   * "Square is not configured" is not a failure to report.
   */
  private async syncItemToPos(orgId: string, swap: Pick<SwapShape, 'id' | 'title' | 'squareCategoryId' | 'locationId'>, item: { id: string; name: string; description: string | null; priceCents: number; sku: string; originalQuantity: number; squareItemId: string | null; squareVariationId: string | null }): Promise<PosSyncResult> {
    if (!swap.locationId) return 'skipped';
    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) return 'skipped';
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

      // Photos taken before the item reached Square have nowhere to go at the
      // time. A station check-in defers this sync until the seller finishes, so
      // that is every photo taken at a station: the picture was stored, the
      // item appeared in Square minutes later, and nothing ever went back for
      // it. Never fatal — an item in Square without its picture beats no item.
      await this.attachPendingPhotos(orgId, item.id, result.posItemId, pos).catch((err: unknown) => {
        console.error('[Square] attachPendingPhotos failed:', err);
      });

      return 'synced';
    } catch (err) {
      console.error('[Square] syncItemToPos failed:', err);
      return 'failed';
    }
  }

  /**
   * Sends up any of an item's photos that Square has not been given yet.
   *
   * Reads them back from our own storage, which is why they are kept there
   * rather than relying on Square's CDN copy: at the moment a check-in photo is
   * taken, there is no Square object to hang it on.
   */
  private async attachPendingPhotos(
    orgId: string,
    itemId: string,
    posItemId: string,
    pos: IPosAdapter,
  ): Promise<void> {
    const pending = await this.prisma.swapItemPhoto.findMany({
      where: { itemId, squareImageId: null, NOT: { s3Key: '' } },
      orderBy: { displayOrder: 'asc' },
    });
    if (pending.length === 0) return;

    for (const photo of pending) {
      const bytes = await this.s3.download(photo.s3Key).catch(() => null);
      if (!bytes) continue;
      const res = await pos
        .uploadImage(posItemId, bytes, 'image/jpeg')
        .catch((err: unknown) => {
          console.error('[Square] uploadImage failed during backfill:', err);
          return null;
        });
      if (!res) continue;
      await this.prisma.swapItemPhoto.update({
        where: { id: photo.id },
        data: { squareImageId: res.posImageId },
      });
    }
  }

  private async fetchInventoryMap(orgId: string, swap: { locationId: string }, items: { squareVariationId: string | null }[]): Promise<Map<string, number>> {
    if (!swap.locationId) return new Map();
    const ids = items.map((i) => i.squareVariationId).filter((id): id is string => !!id);
    if (!ids.length) return new Map();
    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) return new Map();
    return pos.getInventoryCounts(ids, swap.locationId).catch(() => new Map());
  }

  private toResponse(item: { id: string; swapId: string; orgId: string; name: string; description: string | null; sku: string; priceCents: number; originalQuantity: number; squareItemId: string | null; squareVariationId: string | null; donateProceeds: boolean; hasPrintedTag: boolean; consignedAt: Date | null; updatedAt: Date; seller: (SellerNameRow & { id: string }) | null; photos: { id: string; url: string }[] }, inventoryMap: Map<string, number>): ItemResponse {
    const inStock = item.squareVariationId ? (inventoryMap.get(item.squareVariationId) ?? 0) : 0;
    return {
      id: item.id, swapId: item.swapId, orgId: item.orgId,
      name: item.name, description: item.description,
      sku: item.sku, priceCents: item.priceCents, originalQuantity: item.originalQuantity,
      inStock, soldCount: Math.max(0, item.originalQuantity - inStock),
      squareSynced: !!item.squareItemId,
      donateProceeds: item.donateProceeds,
      hasPrintedTag: item.hasPrintedTag,
      consignedAt: item.consignedAt?.toISOString() ?? null,
      seller: item.seller
        ? {
            id: item.seller.id,
            displayName: sellerDisplayName(item.seller) ?? 'Unnamed',
            phone: item.seller.membership.user.phone ?? null,
          }
        : null,
      photos: item.photos.map((p) => ({ id: p.id, url: p.url })),
      updatedAt: item.updatedAt.toISOString(),
    };
  }
}
