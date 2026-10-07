import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
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
import { LegacyTicketService, ticketNumberOf, type ImportFileRow, type ImportResult } from './legacy-ticket.service';
import { matchImportDetails, type MatchedFile } from './import-details';
import { IMPORT_GUIDE_FILES, type ImportGuideFile } from './import-guide';
import type { TaxonomyNode } from '@prisma/client';
import { IssuedTicketService } from './issued-ticket.service';
import { TaxonomyService, type ItemAttributeInput, type ItemDescription } from './taxonomy/taxonomy.service';
import { createId } from '@paralleldrive/cuid2';
import sharp from 'sharp';
import { stationCodeOf, uncategorisedName } from './sku.util';
import type { ItemResponse, UnpricedTicket } from '../contracts/ski-swap.contracts';
import { searchedField, sortRows, type ItemListView, type ItemSort } from './item-list-order';
import { servingDevice } from './device-stock.interceptor';

export interface ItemPhotoResponse { id: string; url: string; }

/**
 * Re-exported from the contract rather than declared again here. This file used
 * to carry its own structurally-identical copy, which is how a response and the
 * schema that documents it drift apart without anything failing to compile.
 */
export type { ItemResponse };

type SwapShape = { id: string; title: string; squareCategoryId: string; locationId: string; skuPrefix: string; skuCounter: number };

/** Items per Square write after a file import: one of Square's batch upserts. */
const IMPORT_PUSH_BATCH = 500;

/** Keys are client-supplied, so they are only ever meaningful within one swap. */
function idempotencyScope(orgId: string, swapId: string): string {
  return `item-create:${orgId}:${swapId}`;
}

/** What a Square push did: landed, was not configured, or errored. */
export type PosSyncResult = 'synced' | 'skipped' | 'failed';

/**
 * A place in a keyset walk: the `(updatedAt, id)` of the last row handed out.
 *
 * Base64 rather than the two values in the open, so a client treats it as a
 * bookmark it received rather than as two fields it may compose. What it is
 * made of is ours to change; that it round-trips is the contract.
 */
export function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    // The first separator, not every one. An id containing a `|` would
    // otherwise come back truncated, and seek to a different row than the one
    // the walk stopped at — quietly, since a shorter id is still a valid id.
    const at = raw.indexOf('|');
    if (at < 0) return null;
    const updatedAt = new Date(raw.slice(0, at));
    const id = raw.slice(at + 1);
    if (!id || Number.isNaN(updatedAt.getTime())) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/** A collision on `@@unique([swapId, sku])` — one number, two items. */
function isDuplicateSku(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

@Injectable()
export class ItemService {
  private readonly logger = new Logger(ItemService.name);

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
    private readonly taxonomy: TaxonomyService,
    // Optional for the unit tests that build this by hand; Nest always supplies it.
    private readonly issued?: IssuedTicketService,
  ) {}

  async list(orgId: string, swapId: string, opts: {
    query?: string; sellerId?: string; skip?: number; take?: number; updatedSince?: string; consigned?: boolean;
    walk?: boolean; after?: { updatedAt: Date; id: string };
  } & ItemListView): Promise<{ items: ItemResponse[]; total: number; syncedAt: string; nextAfter?: string; sortedBy?: ItemSort }> {
    /*
     * Read before the query, not after (iOS Plan 17 D).
     *
     * This is the watermark a client sets its next `updatedSince` to. Taken
     * after the read, a row committed while the query was running would sit
     * between the result set and the new cursor — absent from this answer and
     * excluded from the next one, so gone until somebody edits it again. Taken
     * before, that row is simply returned twice, and an upsert does not mind.
     */
    const syncedAt = new Date();
    const swap = await this.findSwapOrThrow(orgId, swapId);
    // Tombstones appear only in a delta. A client asking "what changed since"
    // holds a local mirror and has to be told about a removal; a caller with no
    // cursor is a screen, and a deleted item has no business on one.
    //
    // The same rule `list` on sellers follows, and for the same reason. It is
    // the only read in the codebase allowed to see a tombstone.
    /*
     * Search: the item's own name and SKU, or a seller whose name, email or
     * phone matches. The sellers are found first, in one small query, so the
     * item filter is an id list rather than a join per row (Plan 39).
     */
    const searchSellerIds = opts.query ? await this.sellersMatching(orgId, opts.query) : [];
    const where = {
      swapId, orgId,
      ...(opts.updatedSince ? {} : { deletedAt: null }),
      ...(opts.sellerId ? { sellerId: opts.sellerId } : {}),
      ...(opts.updatedSince ? { updatedAt: { gt: new Date(opts.updatedSince) } } : {}),
      // The `OR`s (the search's, the cursor's, "not in Square"'s) each their
      // own entry in `AND`, so none replaces another.
      AND: [
        // Missing either id (Plan 41 D14): the same test as the row's badge.
        ...(opts.status === 'not_in_square' ? [{ OR: [{ squareItemId: null }, { squareVariationId: null }] }] : []),
        ...(opts.query ? [{ OR: [
          { name: { contains: opts.query } },
          { sku: { contains: opts.query } },
          ...(searchSellerIds.length ? [{ sellerId: { in: searchSellerIds } }] : []),
        ] }] : []),
        /*
         * Keyset paging for the full pass (iOS Plan 17 E).
         *
         * `skip`/`take` walks a moving list: an item inserted by another station
         * between two pages shifts a live one off the end of a page, and the
         * client — which deletes whatever did not come back — deletes it. A
         * cursor of `(updatedAt, id)` cannot skip a row that way, because it
         * names where it got to rather than how far along it was.
         *
         * `id` breaks the tie: `updatedAt` is not unique, and a cursor on it
         * alone would either repeat or skip the rows sharing a millisecond.
         */
        ...(opts.after
          ? [{
              OR: [
                { updatedAt: { gt: opts.after.updatedAt } },
                { updatedAt: opts.after.updatedAt, id: { gt: opts.after.id } },
              ],
            }]
          : []),
      ],
      // What a staff member still has to look through, or what has been taken.
      ...(opts.consigned === undefined
        ? {}
        : opts.consigned
          ? { consignedAt: { not: null } }
          : { consignedAt: null }),
      ...(opts.printed === undefined ? {} : { hasPrintedTag: opts.printed }),
      // Each is a fact about our own row (D2): never a Square read.
      ...(opts.status === 'not_received' ? { consignedAt: null } : {}),
      ...(opts.status === 'not_in_square' ? { consignedAt: { not: null } } : {}),
      ...(opts.status === 'needs_price' ? { priceCents: null } : {}),
    };

    // Sorted (D3), or searched with no sort asked for (best matches first):
    // every matching row, light, ordered here, then the page cut from it and
    // read in full. See `item-list-order.ts` for why not SQL.
    const searchOrder = !opts.sort && !!opts.query?.trim() && !opts.updatedSince;
    if ((opts.sort || searchOrder) && !opts.walk) {
      const light = await this.prisma.swapItem.findMany({
        // A screen's read, never the delta: no tombstones.
        where: { ...where, deletedAt: null },
        select: { id: true, sku: true, name: true, priceCents: true, hasPrintedTag: true, sellerId: true },
      });
      // A search sorts by the field it searched, ascending, unless a sort was asked for.
      const sortBy: ItemSort = opts.sort ?? searchedField(light, opts.query!);
      const dir = opts.sort ? opts.dir ?? 'asc' : 'asc';
      // Sellers' names once each, for the sort that reads them, not a join per row.
      const sellerNames = new Map<string, string | null>();
      if (sortBy === 'seller') {
        const ids = [...new Set(light.map((r) => r.sellerId).filter((id): id is string => !!id))];
        const sellers = await this.prisma.sellerProfile.findMany({
          where: { id: { in: ids } },
          select: { id: true, businessName: true, ...SELLER_NAME_INCLUDE },
        });
        for (const sl of sellers) sellerNames.set(sl.id, sellerDisplayName(sl));
      }
      const ordered = sortRows(
        light.map((r) => ({ ...r, sellerName: r.sellerId ? sellerNames.get(r.sellerId) ?? null : null })),
        sortBy,
        dir,
      );
      const skip = opts.skip ?? 0;
      const pageIds = ordered.slice(skip, skip + (opts.take ?? 50)).map((r) => r.id);
      const rows = await this.prisma.swapItem.findMany({
        where: { id: { in: pageIds }, deletedAt: null },
        include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
      });
      const byId = new Map(rows.map((r) => [r.id, r]));
      const page = pageIds.map((id) => byId.get(id)).filter((r): r is (typeof rows)[number] => !!r);
      const [inventoryMap, descriptions] = await Promise.all([
        this.displayStock(orgId, swap, page),
        this.fetchDescriptions(page),
      ]);
      return {
        total: ordered.length,
        syncedAt: syncedAt.toISOString(),
        // Which column the order is by, so the page can show it on the heading.
        ...(opts.sort ? {} : { sortedBy: sortBy }),
        items: page.map((i) => this.toResponse(i, inventoryMap, descriptions)),
      };
    }
    /*
     * One transaction, so `total` describes the page beside it rather than a
     * list that moved between the two statements.
     *
     * A keyset walk orders by the cursor's own columns; anything else would
     * page over one order while seeking in another. Offset paging keeps the
     * newest-first order the screens read.
     */
    const [items, total] = await this.prisma.$transaction([
      this.prisma.swapItem.findMany({
        where,
        include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
        orderBy: opts.walk ? [{ updatedAt: 'asc' }, { id: 'asc' }] : [{ createdAt: 'desc' }],
        ...(opts.walk ? {} : { skip: opts.skip ?? 0 }),
        take: opts.take ?? 50,
      }),
      this.prisma.swapItem.count({ where }),
    ]);
    const [inventoryMap, descriptions] = await Promise.all([
      this.displayStock(orgId, swap, items),
      this.fetchDescriptions(items),
    ]);
    /*
     * Where to carry on from, handed back rather than left to be assembled.
     *
     * Absent on the last page, which is how a walk knows it is done — a count
     * comparison would be the thing this mode exists to stop relying on.
     */
    const last = items[items.length - 1];
    const nextAfter =
      opts.walk && last && items.length === (opts.take ?? 50)
        ? encodeCursor(last.updatedAt, last.id)
        : undefined;

    return {
      total,
      syncedAt: syncedAt.toISOString(),
      ...(nextAfter ? { nextAfter } : {}),
      items: items.map((i) => this.toResponse(i, inventoryMap, descriptions)),
    };
  }

  /**
   * The org's sellers whose business name, first or last name, email or phone
   * contains the search: what the Items search matches a seller by.
   */
  private async sellersMatching(orgId: string, query: string): Promise<string[]> {
    // Only when the query has digits in it. Stripped of letters, "rossignol"
    // is the empty string, and `contains: ''` is every phone there is.
    const digits = query.replace(/\D/g, '');
    const rows = await this.prisma.sellerProfile.findMany({
      where: {
        membership: { orgId },
        OR: [
          { businessName: { contains: query } },
          { membership: { user: { firstName: { contains: query } } } },
          { membership: { user: { lastName: { contains: query } } } },
          { membership: { user: { email: { contains: query } } } },
          ...(digits ? [{ membership: { user: { phone: { contains: digits } } } }] : []),
        ],
      },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** A seller's items in the swap, at listed prices (Plan 39 D7). Our own rows only. */
  async sellerSummary(orgId: string, swapId: string, sellerId: string): Promise<{ items: number; listedValueCents: number; unpriced: number }> {
    await this.findSwapOrThrow(orgId, swapId);
    const rows = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId, deletedAt: null },
      select: { priceCents: true, originalQuantity: true },
    });
    return {
      items: rows.length,
      listedValueCents: rows.reduce((sum, r) => sum + (r.priceCents ?? 0) * r.originalQuantity, 0),
      unpriced: rows.filter((r) => r.priceCents === null).length,
    };
  }

  async get(orgId: string, swapId: string, itemId: string): Promise<ItemResponse> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId, deletedAt: null }, include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } } });
    if (!item) throw new NotFoundException('Item not found');
    const [inventoryMap, descriptions] = await Promise.all([
      this.displayStock(orgId, swap, [item]),
      this.fetchDescriptions([item]),
    ]);
    return this.toResponse(item, inventoryMap, descriptions);
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
      /**
       * How the item is described (Plan 19). Optional because a seller on issued
       * tickets can still list one the tree says nothing about — the description
       * is on the paper tag — and then `fallbackName` supplies the name.
       */
      /** An id the client minted. See `ClientMintedId`. */
      id?: string;
      categoryId?: string; attributes?: ItemAttributeInput[]; fallbackName?: string;
      /** What the client already printed. Honoured only with `alreadyPrinted`. */
      name?: string;
      description?: string;
      /** Null or absent only for a legacy ticket (Plan 32); `create` enforces it. */
      priceCents?: number | null; quantity: number;
      sellerId?: string; donateProceeds?: boolean; sku?: string;
      stationId?: string; alreadyPrinted?: boolean;
      /** `false` queues no tag at the bridge; see `CreateItemSchema.queueTag`. */
      queueTag?: boolean;
      /** Whoever is entering this, so a value they type is attributable. */
      actorId?: string;
      /** Staff are entering this: a value they type is approved, not pending. */
      approveNewValues?: boolean;
      /**
       * The seller entered this themselves, with no staff present.
       *
       * Only these can be made to wait: anything a staff member typed or
       * uploaded was already in somebody's hands, and a second handling buys
       * nothing.
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
     * Whether this item waits for a staff member before it can sell.
     *
     * Read once, here, and answered onto the row. Nothing consults it again,
     * which is what lets the org toggle change mid-swap without moving anything
     * already on the floor.
     *
     * Three cases, and the middle one is the point:
     *
     *   staff entered it       — consigned. It was in their hands as they typed.
     *   seller, at a station   — the org's choice. Somebody is standing at the
     *                            table with the gear, so an org that wants the
     *                            extra scan turns `requireConsignmentScan` on
     *                            and an org that does not leaves it off.
     *   seller, anywhere else  — always waits. A shop listing stock from its own
     *                            desk, or uploading a file the night before, has
     *                            handed over nothing yet. Nobody has seen the
     *                            goods, and an item nobody has seen must not be
     *                            sellable.
     *
     * That last case used to be consigned at birth, which put a shop's whole
     * uploaded inventory on the register before a box of it had arrived.
     */
    const awaitsConsignment = data.selfService
      ? station
        ? (await this.settings.get(orgId)).requireConsignmentScan
        : true
      : false;

    const item = await this.create(
      orgId,
      swapId,
      {
        ...data,
        // The tag exists, so what it says is a fact rather than a preference.
        // Without that, a name is just a client's opinion about a string the
        // server can derive itself, and the derivation is the one both clients
        // agree on.
        ...(data.alreadyPrinted && data.name ? { printedName: data.name } : {}),
        stationCode: station?.code ?? null,
        // At a station the person is standing there watching; Square waits for
        // the batch at finish.
        deferPos: !!station,
        awaitsConsignment,
      },
      idempotencyKey,
    );

    // Nothing to queue when the tag is already on the item, through a station
    // that has no bridge, or when the client prints the tag itself as it saves
    // (`queueTag: false`).
    if (station?.bridgeDeviceId && !data.alreadyPrinted && data.queueTag !== false) {
      // The swap's own setting: one swap's tags go on skis that take one at
      // each end, another's on a single hang tag.
      const { labelsPerItem } = await this.prisma.skiSwap.findUniqueOrThrow({
        where: { id: swapId },
        select: { labelsPerItem: true },
      });
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
  async create(orgId: string, swapId: string, data: { id?: string; categoryId?: string; attributes?: ItemAttributeInput[]; fallbackName?: string; printedName?: string; description?: string; priceCents?: number | null; quantity: number; sellerId?: string; donateProceeds?: boolean; sku?: string; stationCode?: string | null; deferPos?: boolean; awaitsConsignment?: boolean; actorId?: string; approveNewValues?: boolean; squareIds?: { itemId: string; variationId: string }; taxonomyNodes?: TaxonomyNode[] }, idempotencyKey?: string): Promise<ItemResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(idempotencyScope(orgId, swapId), idempotencyKey);
      if (cached) return cached as unknown as ItemResponse;
    }

    /*
     * A create under an id this swap already has is the same create arriving
     * twice — an offline queue retrying after a lost response. For creates the
     * id is the idempotency key, so this answers before anything is written.
     *
     * Scoped to the swap. A primary key is unique across the database, not per
     * org, so answering unconditionally would hand back another organization's
     * item for the price of a guessed UUID. Anybody else's row is a conflict,
     * and the message says nothing about whose.
     */
    if (data.id) {
      const already = await this.prisma.swapItem.findUnique({
        where: { id: data.id },
        select: { id: true, orgId: true, swapId: true, deletedAt: true },
      });
      if (already) {
        if (already.orgId !== orgId || already.swapId !== swapId) {
          throw new ConflictException('That id is already in use.');
        }
        // A withdrawn item is not something to resurrect by re-creating it: the
        // tombstone is what tells every cache it went, and handing it back as
        // though the create succeeded would undo that.
        if (already.deletedAt) {
          throw new ConflictException('That item was withdrawn. Create it under a new id.');
        }
        return this.get(orgId, swapId, data.id);
      }
    }

    const swap = await this.findSwapOrThrow(orgId, swapId);
    if (data.sellerId) await this.sellerService.findOrThrow(orgId, data.sellerId);

    let sku: string;
    if (data.sku) {
      sku = data.sku;
    } else {
      sku = await this.skuService.next(swapId, data.stationCode ?? null);
    }

    /**
     * A legacy ticket may wait for its price (Plan 32): the gear is checked in
     * with its paper ticket, and staff price it before sales start. Square
     * sells one still unpriced at a price the clerk types. Anything else needs
     * a price now, and this is the one place every create path passes through.
     */
    const priceCents = data.priceCents ?? null;
    if (priceCents === null && ticketNumberOf(sku) === null) {
      throw new BadRequestException('Enter a price. Only a legacy ticket can be added without one.');
    }

    /**
     * The name is composed here, from the tree, and then frozen (Plan 19 D5).
     *
     * A category is the ordinary path. Without one the item is named by its tag
     * number, `Item #<sku>` (iOS Plan 20), whoever adds it — unless the caller
     * has a name of its own, like a row of an imported file. `SwapItem.name` is
     * non-null and Square requires a name. Giving the item a category later
     * derives a real one in its place.
     */
    if (!data.categoryId && data.attributes?.length) {
      throw new BadRequestException('Pick what the item is before describing it');
    }
    const described = data.categoryId
      ? await this.taxonomy.resolveAnswers(orgId, data.categoryId, data.attributes ?? [], data.actorId, { approveNew: data.approveNewValues, nodes: data.taxonomyNodes })
      : null;

    /**
     * A name the printing client supplied wins over the derivation.
     *
     * Only reachable when that client also said the tag is already on the item
     * (`alreadyPrinted`), which `createAtStation` checks before passing it here.
     * The attributes are still validated and still stored either way — this
     * decides one column, not what the item is.
     */
    const name =
      data.printedName?.trim() || described?.name || data.fallbackName?.trim() || uncategorisedName(sku);

    // A ticket that's already an item is refused saying whose (Plan 38 D8):
    // issued tickets exist from the start, so this is the usual way to meet
    // one. The unique index below stays the guard against a race.
    if (ticketNumberOf(sku) !== null && (await this.tickets.takenBy(swapId, sku))) {
      throw await this.ticketTaken(swapId, sku);
    }

    const item = await this.prisma.swapItem.create({
      data: {
        // The client's, when it brought one (iOS Plan 17 A). Checked against
        // this swap before we get here, so by now it is either free or ours.
        id: data.id ?? createId(), swapId, orgId, sellerId: data.sellerId ?? null,
        name, description: data.description ?? null,
        categoryId: described?.categoryId ?? null,
        ...(described && described.rows.length > 0
          ? { attributes: { create: described.rows.map((r) => ({ id: createId(), ...r })) } }
          : {}),
        // Both, always. `liveSku` is what the unique index watches; `sku` is
        // what the tag says and is never cleared.
        priceCents, sku, liveSku: sku, originalQuantity: data.quantity,
        donateProceeds: data.donateProceeds ?? false,
        /**
         * The setting is read by the caller and answered here, once. An item
         * that must wait carries null; everything else is consigned at birth,
         * which is what lets the org toggle change later without moving
         * anything already on the floor.
         */
        consignedAt: data.awaitsConsignment ? null : new Date(),
        // Already in Square (Plan 41's Copy to PatrolKit): linked, not pushed.
        ...(data.squareIds
          ? { squareItemId: data.squareIds.itemId, squareVariationId: data.squareIds.variationId, lastSyncedAt: new Date() }
          : {}),
      },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: true },
    }).catch(async (err: unknown) => {
      /**
       * `@@unique([swapId, liveSku])` is the only thing standing between one
       * physical ticket and two live items, and it was reaching the client as a
       * bare 500. Scanning a ticket that is already on something is the likeliest
       * thing to happen at a counter — a re-scan, or two stations working the
       * same pile — and a volunteer holding an iPad needs to be told which
       * ticket, not "Internal server error".
       *
       * Caught rather than checked beforehand: a look-then-insert leaves a gap
       * two stations can both pass through, and the index does not.
       */
      if (isDuplicateSku(err)) {
        throw ticketNumberOf(sku) !== null
          ? await this.ticketTaken(swapId, sku)
          : new ConflictException(`${sku} is already in use in this swap.`);
      }
      throw err;
    });

    // Square is where "on sale" lives, so an item waiting to be accepted must
    // not reach it — not priced at zero, not flagged: absent.
    if (!data.deferPos && !data.awaitsConsignment && !data.squareIds) await this.syncItemToPos(orgId, swap, item);

    const refreshed = data.deferPos
      ? item
      : await this.prisma.swapItem.findFirstOrThrow({ where: { id: item.id, deletedAt: null }, include: { seller: { include: SELLER_NAME_INCLUDE }, photos: true } });
    // Inventory is a Square read, so it goes with the write it belongs to.
    const inventoryMap = data.deferPos
      ? new Map<string, number>()
      : await this.displayStock(orgId, swap, [refreshed]);
    const descriptions = await this.fetchDescriptions([refreshed]);
    const response = this.toResponse(refreshed, inventoryMap, descriptions);

    if (idempotencyKey) {
      await this.idempotency.save(
        idempotencyScope(orgId, swapId),
        idempotencyKey,
        response as unknown as Record<string, unknown>,
      );
    }

    return response;
  }

  /**
   * The swap's tickets that still need a price (Plan 37), in number order: the
   * fast edit's SKU suggestions. Only what a suggestion shows, so it stays
   * cheap to fetch on every open.
   */
  async unpricedTickets(orgId: string, swapId: string): Promise<UnpricedTicket[]> {
    await this.findSwapOrThrow(orgId, swapId);
    const rows = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, deletedAt: null, priceCents: null },
      select: { id: true, sku: true, name: true, categoryId: true, seller: { include: SELLER_NAME_INCLUDE } },
    });
    return rows
      .filter((r) => ticketNumberOf(r.sku) !== null)
      .sort((a, b) => ticketNumberOf(a.sku)! - ticketNumberOf(b.sku)!)
      .map((r) => ({
        id: r.id,
        sku: r.sku,
        name: r.name,
        placeholderName: r.name === uncategorisedName(r.sku),
        categoryId: r.categoryId,
        sellerName: sellerDisplayName(r.seller),
      }));
  }

  async patch(orgId: string, swapId: string, itemId: string, data: { categoryId?: string; attributes?: ItemAttributeInput[]; name?: string; description?: string | null; priceCents?: number | null; quantity?: number; sellerId?: string | null; donateProceeds?: boolean; hasPrintedTag?: boolean; ifUnpriced?: true; actorId?: string; approveNewValues?: boolean; deferPos?: boolean; taxonomyNodes?: TaxonomyNode[] }, idempotencyKey?: string): Promise<ItemResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(`item-patch:${orgId}:${swapId}`, idempotencyKey);
      if (cached) return cached as unknown as ItemResponse;
    }
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const existing = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId, deletedAt: null }, include: { attributes: true } });
    if (!existing) throw new NotFoundException('Item not found');
    // Said before anything is redescribed; the write below checks again.
    if (data.ifUnpriced && existing.priceCents !== null) throw ticketPriced(existing.sku, existing.priceCents);
    if (data.sellerId) await this.sellerService.findOrThrow(orgId, data.sellerId);

    /**
     * Re-derives the name when the description changed (Plan 19 §5).
     *
     * Either half may arrive alone — a category with no answers clears them, a
     * set of answers keeps the category — so the two are read from the row when
     * not supplied. An edit that touches neither leaves the name exactly as it
     * was, which is what makes a price change not rewrite a tag.
     */
    const redescribed =
      data.categoryId !== undefined || data.attributes !== undefined
        ? await this.redescribe(orgId, existing, data)
        : null;

    const updated = await this.prisma.swapItem.update({
      // With `ifUnpriced`, the write itself requires no price, so a price set
      // between the check above and here is refused rather than overwritten.
      where: { id: itemId, ...(data.ifUnpriced ? { priceCents: null } : {}) },
      data: {
        // An explicit name replaces the derivation, and survives a redescribe in
        // the same request: the client is stating what its tag says.
        ...(data.name ? { name: data.name.trim() } : {}),
        ...(redescribed
          ? {
              ...(data.name ? {} : { name: redescribed.name }),
              categoryId: redescribed.categoryId,
              // Replaced wholesale: a partial update would leave an answer to a
              // question the new category does not ask.
              attributes: {
                deleteMany: {},
                create: redescribed.rows.map((r) => ({ id: createId(), ...r })),
              },
            }
          : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.priceCents !== undefined ? { priceCents: data.priceCents } : {}),
        ...(data.quantity !== undefined ? { originalQuantity: data.quantity } : {}),
        ...(data.sellerId !== undefined ? { sellerId: data.sellerId } : {}),
        ...(data.donateProceeds !== undefined ? { donateProceeds: data.donateProceeds } : {}),
        ...(data.hasPrintedTag !== undefined ? { hasPrintedTag: data.hasPrintedTag } : {}),
      },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
    }).catch(async (err: unknown) => {
      // No row matched: priced since the check above (Plan 37).
      if (data.ifUnpriced && (err as { code?: string }).code === 'P2025') {
        const now = await this.prisma.swapItem.findFirst({ where: { id: itemId, deletedAt: null }, select: { priceCents: true } });
        throw ticketPriced(existing.sku, now?.priceCents ?? null);
      }
      throw err;
    });

    // A file import writes every row first and sends Square the lot after.
    if (!data.deferPos) await this.syncItemToPos(orgId, swap, updated);

    if (data.quantity !== undefined && updated.squareVariationId && swap.locationId) {
      const pos = await this.posFactory.forOrg(orgId);
      if (pos) await pos.setInventoryPhysicalCount(updated.squareVariationId, swap.locationId, data.quantity).catch(() => {});
    }

    /*
     * A label printed from the web for an item whose SKU the web made (Plan 31)
     * is that item going on the floor: no counter scan follows for it. The
     * shop printed it at home and brings the gear tagged, so it is accepted
     * here, by whoever printed it, and reaches Square. A ticket or a station
     * SKU keeps waiting for staff as before.
     */
    const response =
      data.hasPrintedTag === true && !existing.consignedAt && isWebMadeSku(updated.sku)
        ? await this.consign(orgId, swapId, itemId, data.actorId ?? null)
        : await (async () => {
            const [inventoryMap, descriptions] = await Promise.all([
              // Stock is a Square read: none for a deferred write.
              data.deferPos ? new Map<string, number>() : this.displayStock(orgId, swap, [updated]),
              this.fetchDescriptions([updated]),
            ]);
            return this.toResponse(updated, inventoryMap, descriptions);
          })();
    if (idempotencyKey) {
      await this.idempotency.save(
        `item-patch:${orgId}:${swapId}`,
        idempotencyKey,
        response as unknown as Record<string, unknown>,
      );
    }
    return response;
  }

  /**
   * What an edited item's description becomes.
   *
   * Refuses an item that never had a category and is being given answers
   * without one: there would be nothing to check them against, and no head noun
   * to end the name with.
   */
  private async redescribe(
    orgId: string,
    existing: { categoryId: string | null; attributes: { attributeId: string; valueId: string | null; numberValue: number | null }[] },
    data: { categoryId?: string; attributes?: ItemAttributeInput[]; actorId?: string; approveNewValues?: boolean; taxonomyNodes?: TaxonomyNode[] },
  ) {
    const categoryId = data.categoryId ?? existing.categoryId;
    if (!categoryId) {
      throw new BadRequestException('Pick what the item is before describing it');
    }
    const attributes: ItemAttributeInput[] =
      data.attributes ??
      existing.attributes.map((a) => ({
        attributeId: a.attributeId,
        ...(a.valueId !== null ? { valueId: a.valueId } : {}),
        ...(a.numberValue !== null ? { numberValue: a.numberValue } : {}),
      }));
    return this.taxonomy.resolveAnswers(orgId, categoryId, attributes, data.actorId, { approveNew: data.approveNewValues, nodes: data.taxonomyNodes });
  }

  /**
   * Removes an item, leaving a tombstone.
   *
   * The row stays because absence is not something a delta can carry: an iPad
   * holding a copy learns of a deletion from a row that says it was deleted, or
   * it learns of it by asking for every item in the swap and noticing what did
   * not come back — which used to take about twenty-two minutes, and on a
   * device relaunched between sellers could take the whole swap. Until then
   * staff could print a tag for an item the server does not have.
   *
   * Everything outside the database still goes: the photo rows and their files,
   * the Square catalogue entry, the Square images. A tombstone is a fact for a
   * cache to read, not a reason to keep paying for storage or to leave
   * something sellable on a register.
   */
  async remove(orgId: string, swapId: string, itemId: string): Promise<void> {
    await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({
      where: { id: itemId, swapId, orgId, deletedAt: null },
      include: { photos: true },
    });
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

    await this.prisma.$transaction([
      this.prisma.swapItemPhoto.deleteMany({ where: { itemId } }),
      this.prisma.swapItem.update({
        where: { id: itemId },
        // `liveSku` goes to null and the ticket goes back in the pile, which is
        // what happens physically. `sku` stays: it is what the tag says, and a
        // receipt line naming it has to keep meaning something.
        // `updatedAt` moves on its own, which is what puts this in the delta.
        data: { deletedAt: new Date(), liveSku: null },
      }),
    ]);
  }

  async uploadPhoto(orgId: string, swapId: string, itemId: string, file: { buffer: Buffer; mimetype: string; originalname: string }, idempotencyKey?: string): Promise<{ id: string; url: string }> {
    /*
     * Checked before a byte is resized or uploaded (iOS Plan 17 B).
     *
     * A retried upload is the costliest of the three to get wrong: it is a
     * second copy of the same picture on the item, in S3 and in Square, and
     * nothing about the item says the two are the same photograph.
     */
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(`item-photo:${orgId}:${swapId}`, idempotencyKey);
      if (cached) return cached as unknown as { id: string; url: string };
    }
    await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId, deletedAt: null } });
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
    const response = { id: photo.id, url: photo.url };
    if (idempotencyKey) {
      await this.idempotency.save(`item-photo:${orgId}:${swapId}`, idempotencyKey, response);
    }
    return response;
  }

  async deletePhoto(orgId: string, swapId: string, itemId: string, photoId: string): Promise<void> {
    await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId, deletedAt: null } });
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

  /**
   * A shop's whole inventory from one file, every row a ticket they hold.
   *
   * Checked here and written here, but the rules live on `LegacyTicketService`
   * — which this service already depends on, and which therefore cannot call
   * back into it. Nothing is written unless every row passes.
   *
   * The writes go through `create` rather than straight to Prisma, which is the
   * whole point: it is the one place that knows about consignment, Square, and
   * how the two relate, and a row made by hand here would agree with none of it.
   */
  /**
   * The staff path: a file a shop sent in, uploaded on their behalf.
   *
   * Gated on the swap accepting legacy tickets, which is the switch the rest of
   * that UI hangs off. The shop's own upload is deliberately *not* gated the
   * same way — it is governed by holding ranges, so turning the swap setting
   * off cannot strand a seller holding paper mid-event.
   */
  async importForSeller(
    orgId: string,
    swapId: string,
    sellerId: string,
    file: { headers: string[]; rows: ImportFileRow[] },
    opts: { generateSkus?: boolean; acceptUnknown?: boolean } = {},
  ): Promise<ImportResult> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    // Staff upload ticket rows only for a swap whose web takes legacy tickets;
    // generated rows go in either way, and ticket rows among them are refused.
    if (!swap.allowLegacyWeb && !opts.generateSkus) {
      throw new BadRequestException('This swap doesn’t take legacy tickets on the web.');
    }
    await this.sellerService.findOrThrow(orgId, sellerId);
    // Staff uploaded it, so the goods are already accounted for.
    return this.importItems(orgId, swapId, sellerId, file.rows, {
      selfService: false,
      generateSkus: opts.generateSkus,
      headers: file.headers,
      acceptUnknown: opts.acceptUnknown,
    });
  }

  /**
   * A seller's inventory from a spreadsheet, by the seller or by staff for
   * them. Checked whole before anything is written (`checkImportRows`).
   *
   * A row with a ticket fills in the issued ticket it names. A row without
   * one, when SKUs are generated (Plan 31), gets the swap's next SKU, without
   * a station letter, and a label to print.
   *
   * Its category and details (Plan 42) are matched against the tree once for
   * the file. A cell that matches nothing refuses the file, listed, unless the
   * uploader chose to import anyway (`acceptUnknown`): then it isn't stored,
   * and the rest of its row is.
   */
  async importItems(
    orgId: string,
    swapId: string,
    sellerId: string,
    rows: ImportFileRow[],
    opts: { selfService: boolean; generateSkus?: boolean; headers?: string[]; acceptUnknown?: boolean },
  ): Promise<ImportResult> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const results = await this.tickets.checkImportRows(swapId, sellerId, rows, {
      generateSkus: !!opts.generateSkus,
      webTicketsOnly: !swap.allowPrintWeb,
      // Ticket rows only where the web takes legacy tickets (Plan 34), for a
      // shop's own file as well as staff's.
      acceptsTickets: swap.allowLegacyWeb,
      // A shop fills in each ticket once; staff aren't held to that (Plan 38).
      shopOwn: opts.selfService,
    });

    // Matched before deciding anything, so a refused file lists its unknowns
    // beside its row errors and both can be fixed in one go.
    const matched: MatchedFile = opts.headers?.length
      ? matchImportDetails(opts.headers, rows.map((r) => r.cells ?? []), await this.taxonomy.resolve(orgId, { full: true }))
      : { rows: rows.map(() => ({ attributes: [], unknown: [] })), ignoredColumns: [] };
    matched.rows.forEach((m, i) => {
      if (m.categoryId) results[i] = { ...results[i], categoryId: m.categoryId };
      if (m.unknown.length) results[i] = { ...results[i], unknown: m.unknown };
    });
    const answer = (refused: ImportResult['refused']): ImportResult =>
      ({ rows: results, ignoredColumns: matched.ignoredColumns, refused });

    if (results.some((r) => r.outcome === 'error')) return answer('errors');

    // Nor may a shop's file describe a ticket that has already sold (D6).
    if (opts.selfService) {
      const sold = await this.soldAmong(orgId, swapId, results.map((r) => r.itemId).filter((id): id is string => !!id));
      if (sold.size) {
        results.forEach((r, i) => {
          if (r.itemId && sold.has(r.itemId)) results[i] = { ...r, outcome: 'error', error: `${r.sku} has sold. Ask the swap’s staff to change it.` };
        });
        return answer('errors');
      }
    }

    if (!opts.acceptUnknown && matched.rows.some((m) => m.unknown.length)) return answer('unknown');

    // The tree once for every item described, not once per row (D9).
    const taxonomyNodes = matched.rows.some((m) => m.categoryId) ? await this.taxonomy.answerNodes(orgId) : undefined;

    /*
     * Rows are written first and Square follows in the background, in
     * batches: a push per row kept a shop's 1,000-row file waiting on Square
     * for minutes, well past the request's timeout.
     */
    const written: string[] = [];
    const writeRow = async (i: number) => {
      const { categoryId, attributes } = matched.rows[i];
      // Only what matched; an unknown category leaves the row as it was.
      const described = categoryId ? { categoryId, attributes, taxonomyNodes } : {};
      const name = rows[i].name?.trim();

      // A ticket row fills in the issued ticket it names (Plan 38): the ticket
      // exists from the moment it was issued, so there's nothing to create.
      const itemId = results[i].itemId;
      if (itemId) {
        const description = rows[i].description?.trim();
        const changes = {
          // The file's name stays the tag name, with the details beside it (D7).
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(rows[i].priceCents !== null ? { priceCents: rows[i].priceCents! } : {}),
          ...described,
        };
        // A row that only names its ticket changes nothing, so it writes nothing.
        if (Object.keys(changes).length) {
          await this.patch(orgId, swapId, itemId, { ...changes, deferPos: true });
          written.push(itemId);
        }
        results[i] = { ...results[i], outcome: 'updated' };
        return;
      }

      const generated = !!results[i].generated;
      const sku = generated ? undefined : rows[i].sku.trim();
      const item = await this.create(orgId, swapId, {
        // Named by the file when it has a name, described or not; otherwise a
        // described item gets its composed name, and an undescribed one is
        // called by its number by `create`.
        ...(name ? (categoryId ? { printedName: name } : { fallbackName: name }) : {}),
        ...described,
        description: rows[i].description?.trim() || undefined,
        priceCents: rows[i].priceCents,
        quantity: 1,
        sellerId,
        sku,
        awaitsConsignment: opts.selfService,
        deferPos: true,
      });
      written.push(item.id);

      // A generated SKU has no label yet: the seller prints one from the web.
      if (generated) {
        results[i] = { ...results[i], sku: item.sku, outcome: 'created' };
        return;
      }

      // `create` has no `alreadyPrinted` — that belongs to the station path —
      // so this is set after the fact. Without it the shop is offered a reprint
      // of a ticket that came out of a box.
      await this.prisma.swapItem.update({
        where: { id: item.id },
        data: { hasPrintedTag: true },
      });

      results[i] = { ...results[i], outcome: 'created' };
    };

    /*
     * The checks above are the ones the writes make, so a row failing here is
     * a change in between (a value retired, a ticket taken). It's reported on
     * its line, and the rows after it still go in: stopping would leave the
     * file half-written with nothing saying which half.
     */
    for (let i = 0; i < rows.length; i++) {
      await writeRow(i).catch((err: unknown) => {
        this.logger.warn({ err, orgId, swapId, line: results[i].line }, 'Import row failed to write');
        results[i] = { ...results[i], outcome: 'error', error: err instanceof HttpException ? err.message : 'Couldn’t be saved.' };
      });
    }

    void this.withItemLock(`import:${swapId}`, () => this.pushImported(orgId, swapId, written));
    return answer(null);
  }

  /** One of the downloads beside an item upload (Plan 42 D12), from the patrol's tree as it is now. */
  async importGuide(orgId: string, file: ImportGuideFile): Promise<{ csv: string; filename: string }> {
    const tree = await this.taxonomy.resolve(orgId, { full: true });
    return IMPORT_GUIDE_FILES[file](tree);
  }

  /**
   * The Square half of a file import, after the uploader has been answered:
   * the accepted ones among `itemIds`, in batches. Items waiting to be
   * accepted stay out of Square, as ever. Never throws; nothing is waiting.
   *
   * Issued tickets not in Square yet go up through their own push first,
   * which reads what was just written. Otherwise a block issued moments
   * before could be created twice, once by each.
   */
  private async pushImported(orgId: string, swapId: string, itemIds: string[]): Promise<void> {
    try {
      if (itemIds.length === 0) return;
      const swap = await this.findSwapOrThrow(orgId, swapId);
      if (!swap.locationId) return;
      const pos = await this.posFactory.forOrg(orgId);
      if (!pos) return;
      await this.issued?.push(orgId, swapId);

      let categoryId = swap.squareCategoryId;
      let failed = 0;
      for (let at = 0; at < itemIds.length; at += IMPORT_PUSH_BATCH) {
        const items = await this.prisma.swapItem.findMany({
          where: { id: { in: itemIds.slice(at, at + IMPORT_PUSH_BATCH) }, swapId, deletedAt: null, consignedAt: { not: null } },
        });
        if (items.length === 0) continue;
        const { results, resolvedCategoryId } = await pos.upsertItems(
          items.map((o) => ({
            posItemId: o.squareItemId ?? undefined,
            posVariationId: o.squareVariationId ?? undefined,
            name: o.name,
            description: o.description ?? undefined,
            priceCents: o.priceCents,
            sku: o.sku,
            categoryId,
            categoryName: swap.title,
          })),
          swap.locationId,
          1,
        );
        if (resolvedCategoryId && resolvedCategoryId !== categoryId) {
          categoryId = resolvedCategoryId;
          await this.prisma.skiSwap.update({ where: { id: swapId }, data: { squareCategoryId: categoryId } });
        }
        const syncedAt = new Date();
        const landed = items.flatMap((o, i) => {
          const r = results[i];
          if ('error' in r) {
            failed++;
            return [];
          }
          return [this.prisma.swapItem.update({
            where: { id: o.id },
            data: { squareItemId: r.posItemId, squareVariationId: r.posVariationId, lastSyncedAt: syncedAt },
          })];
        });
        await this.prisma.$transaction(landed);
      }
      // Left as they are for Diagnostics, or a re-push from Items, to find.
      if (failed) this.logger.warn({ orgId, swapId, failed, of: itemIds.length }, 'Import finished with items not in Square');
    } catch (err) {
      this.logger.error({ err, orgId, swapId }, 'Square push after an import stopped');
    }
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
      // A tombstone keeps its `sku` — the tag in somebody's hand still says it
      // — so scanning a withdrawn item must find nothing rather than find this.
      where: { orgId, swapId, sku: tag, deletedAt: null },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
    });
    if (!item) throw new NotFoundException(`No item in this swap has tag ${tag}.`);
    const inventoryMap = await this.displayStock(orgId, swap, [item]);
    return this.toResponse(item, inventoryMap);
  }

  /**
   * Accepts everything a seller is still waiting on, in one go.
   *
   * What staff press when a shop's boxes arrive and the list of what is in them
   * was uploaded a week ago. The alternative is scanning two hundred tags to
   * say something they already know.
   *
   * The rows are consigned in a single write and the answer goes back
   * immediately; the Square pushes run behind it. Two hundred sequential calls
   * to Square is minutes, and holding an HTTP request open for that would trade
   * a screen that works for one that times out halfway with no way to tell what
   * landed.
   *
   * Losing a push is already a state this app has a name for: the item shows as
   * `Not in Square` on the items page, with a button to push it again. So a
   * crash mid-batch leaves the same visible, fixable condition as a Square
   * outage does, rather than a new one.
   */
  async consignAllForSeller(
    orgId: string,
    swapId: string,
    sellerId: string,
    actorId: string | null,
  ): Promise<{ consigned: number }> {
    await this.findSwapOrThrow(orgId, swapId);

    const waiting = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId, consignedAt: null, deletedAt: null },
      select: { id: true },
    });
    if (!waiting.length) return { consigned: 0 };

    const ids = waiting.map((w) => w.id);

    /**
     * The same set, three times over: updated, pushed, and counted.
     *
     * This used to re-run the filter for the update instead of naming the rows
     * it had just read. A row created in the gap — a shop adding one while a
     * volunteer presses the button — then matched the update, was consigned,
     * and was not in the list handed to Square. It went sellable-in-name-only
     * and uncounted, so nothing on any screen said to go and look at it.
     *
     * Naming the ids makes the gap harmless in the other direction: a row that
     * arrives late is simply not in this batch. It stays visibly waiting, and
     * the next press takes it.
     *
     * `consignedAt: null` stays in the filter so two volunteers pressing at
     * once cannot restamp each other's work, and `count` is what this call
     * actually changed rather than what it hoped to.
     */
    /*
     * One row at a time, so the answer says *which* rows this press changed.
     *
     * A single `updateMany` over the whole set returned a count, and the push
     * then went by the snapshot — every id, whether or not this press was the
     * one that stamped it. Two volunteers pressing together both pushed every
     * item, and two pushes of an item that has no Square id yet are two
     * creates: Square ended up holding two of it, each with stock, under one
     * SKU. The register could sell the same skis twice.
     *
     * `consignedAt: null` in each filter is what makes this safe: only one
     * press can take a given row, and only that press pushes it.
     */
    const now = new Date();
    const taken: string[] = [];
    for (const id of ids) {
      const { count } = await this.prisma.swapItem.updateMany({
        where: { id, consignedAt: null },
        data: { consignedAt: now, consignedBy: actorId },
      });
      if (count === 1) taken.push(id);
    }

    if (taken.length) void this.pushConsignedBatch(orgId, swapId, taken);

    return { consigned: taken.length };
  }

  /**
   * The Square half of a batch consign, after the caller has been answered.
   *
   * Never throws. Nothing is waiting on it, so a rejection here would be an
   * unhandled one, and the item's own state already records what happened.
   */
  private async pushConsignedBatch(orgId: string, swapId: string, itemIds: string[]) {
    let failed = 0;
    for (const itemId of itemIds) {
      const result = await this.syncToPos(orgId, swapId, itemId).catch((err: unknown) => {
        this.logger.error({ err, itemId }, 'Square push threw during batch consign');
        return null;
      });
      // `PosSyncResult` is 'synced' | 'skipped' | 'failed'. `skipped` is an org
      // with no Square, which is not a failure and has nothing to re-push.
      if (result === null || result === 'failed') failed++;
    }
    if (failed) {
      this.logger.warn(
        { orgId, swapId, failed, of: itemIds.length },
        'Batch consign finished with items not in Square',
      );
    }
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
    const existing = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId, swapId, deletedAt: null } });
    if (!existing) throw new NotFoundException('Item not found');

    /*
     * Conditional on the row still waiting, not on what was read a moment ago.
     *
     * A scanner double-reads a barcode constantly, and the two reads arrive as
     * two requests a few milliseconds apart. Both used to see `consignedAt`
     * null, both stamped it, and both pushed — and a push of an item with no
     * Square id yet is a create, so Square got two of it under one SKU. Whoever
     * loses this update finds `count` 0 and does nothing, which is the "second
     * scan is not an error" promise kept without the second catalogue entry.
     */
    const { count } = await this.prisma.swapItem.updateMany({
      where: { id: itemId, consignedAt: null },
      data: { consignedAt: new Date(), consignedBy: actorId },
    });
    if (count === 1) {
      const accepted = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, deletedAt: null } });
      // The item reaches the catalogue exactly here — being accepted and being
      // sellable are the same event.
      await this.syncItemToPos(orgId, swap, accepted);
    }

    const item = await this.prisma.swapItem.findFirstOrThrow({
      where: { id: itemId, deletedAt: null },
      include: { seller: { include: SELLER_NAME_INCLUDE }, photos: { orderBy: { displayOrder: 'asc' } } },
    });
    const inventoryMap = await this.displayStock(orgId, swap, [item]);
    return this.toResponse(item, inventoryMap);
  }

  /**
   * Pushes one already-saved item to Square. The batched half of D17 — check-in
   * defers every push to finish, and this is what finish calls.
   */
  async syncToPos(orgId: string, swapId: string, itemId: string): Promise<PosSyncResult> {
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, swapId, deletedAt: null } });
    return this.syncItemToPos(orgId, swap, item);
  }

  /**
   * Swallows Square failures, and reports which of the three things happened.
   * Save paths ignore the result — a POS outage must not fail a save — but the
   * batched push at check-in finish tells the seller what actually landed, and
   * "Square is not configured" is not a failure to report.
   */
  private async syncItemToPos(orgId: string, swap: Pick<SwapShape, 'id' | 'title' | 'squareCategoryId' | 'locationId'>, item: { id: string; name: string; description: string | null; priceCents: number | null; sku: string; originalQuantity: number; squareItemId: string | null; squareVariationId: string | null; consignedAt: Date | null }): Promise<PosSyncResult> {
    if (!swap.locationId) return 'skipped';
    /*
     * Never before it is accepted. An item is in Square exactly when
     * `consignedAt` is set — that is the contract every screen reads — and an
     * edit used to break it: a seller correcting a price from their phone, or
     * a shop tidying inventory that had not arrived, pushed the item on sale
     * while the web still said it could not be sold.
     */
    if (item.consignedAt === null) return 'skipped';
    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) return 'skipped';
    /*
     * One push per item at a time, and each push starts from the ids the
     * previous one stored. Two pushes of the same item in flight together —
     * check-in finish against a staff re-push, or two "Accept all" presses —
     * both read no Square id and both created one. Serialised, the second
     * reads the first's id and is the update it was always meant to be.
     */
    return this.withItemLock(item.id, async () => {
      const latest = await this.prisma.swapItem.findFirst({
        where: { id: item.id, deletedAt: null },
        select: { squareItemId: true, squareVariationId: true },
      });
      // Withdrawn while this waited its turn: nothing to put on sale.
      if (!latest) return 'skipped';
      const squareItemId = latest.squareItemId ?? item.squareItemId;
      const squareVariationId = latest.squareVariationId ?? item.squareVariationId;
      return this.pushToPos(orgId, swap, pos, { ...item, squareItemId, squareVariationId });
    });
  }

  private readonly itemLocks = new Map<string, Promise<unknown>>();

  /** Runs `fn` after any other call for the same item has finished. */
  private withItemLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.itemLocks.get(itemId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    // Keyed on the chain itself so a later caller clears only its own entry.
    const entry = run.then(() => undefined, () => undefined);
    this.itemLocks.set(itemId, entry);
    void entry.then(() => { if (this.itemLocks.get(itemId) === entry) this.itemLocks.delete(itemId); });
    return run;
  }

  /** "Ticket 67169 belongs to Stowe Sports." The refusal for a ticket that's already an item (D8). */
  private async ticketTaken(swapId: string, sku: string): Promise<ConflictException> {
    const taken = await this.tickets.takenBy(swapId, sku);
    return new ConflictException({
      code: 'TICKET_TAKEN',
      message: taken?.sellerName ? `Ticket ${sku} belongs to ${taken.sellerName}.` : `Ticket ${sku} is already on another item.`,
    });
  }

  private async pushToPos(orgId: string, swap: Pick<SwapShape, 'id' | 'title' | 'squareCategoryId' | 'locationId'>, pos: IPosAdapter, item: { id: string; name: string; description: string | null; priceCents: number | null; sku: string; originalQuantity: number; squareItemId: string | null; squareVariationId: string | null }): Promise<PosSyncResult> {
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

  /**
   * Square's stock for these items, or null when Square could not say.
   *
   * Null rather than an empty map, deliberately. An empty map reads as "none
   * of these has any stock", and a Square outage used to turn into exactly
   * that: every synced item in the swap showed as sold, and the dashboard
   * summed the lot as revenue. Not knowing is a different answer from zero,
   * and the response says which it is (`inventoryKnown`).
   */
  /**
   * Which of these items Square says have sold: in Square, and none left in
   * stock. One read for all of them. Square not answering is not "sold".
   */
  async soldAmong(orgId: string, swapId: string, itemIds: string[]): Promise<Set<string>> {
    if (itemIds.length === 0) return new Set();
    const swap = await this.findSwapOrThrow(orgId, swapId);
    const items = await this.prisma.swapItem.findMany({
      where: { id: { in: itemIds }, deletedAt: null },
      select: { id: true, squareVariationId: true },
    });
    const stock = await this.fetchInventoryMap(orgId, swap, items);
    if (stock === null) return new Set();
    return new Set(items.filter((i) => i.squareVariationId && (stock.get(i.squareVariationId) ?? 0) < 1).map((i) => i.id));
  }

  /**
   * Stock for showing, not for deciding (Plan 39): skipped for a device, which
   * never reads it and gets no stock fields (D8). `soldAmong`, which decides,
   * reads Square whoever is asking.
   */
  private async displayStock(orgId: string, swap: { locationId: string }, items: { squareVariationId: string | null }[]): Promise<Map<string, number> | null> {
    return servingDevice() ? new Map() : this.fetchInventoryMap(orgId, swap, items);
  }

  private async fetchInventoryMap(orgId: string, swap: { locationId: string }, items: { squareVariationId: string | null }[]): Promise<Map<string, number> | null> {
    if (!swap.locationId) return new Map();
    const ids = items.map((i) => i.squareVariationId).filter((id): id is string => !!id);
    if (!ids.length) return new Map();
    const pos = await this.posFactory.forOrg(orgId);
    if (!pos) return new Map();
    return pos.getInventoryCounts(ids, swap.locationId).catch((err: unknown) => {
      this.logger.warn({ err, orgId, count: ids.length }, 'Square inventory read failed; stock is unknown');
      return null;
    });
  }

  /**
   * Fetches the answers for a batch of items, keyed by item id.
   *
   * Beside `fetchInventoryMap`, and for the same reason: a response needs two
   * things the item row does not carry, and both are read once per request
   * rather than once per item.
   */
  private async fetchDescriptions(items: { id: string; categoryId: string | null }[]): Promise<Map<string, ItemDescription>> {
    return this.taxonomy.describeItems(items);
  }

  private toResponse(item: { id: string; swapId: string; orgId: string; name: string; description: string | null; sku: string; priceCents: number | null; originalQuantity: number; squareItemId: string | null; squareVariationId: string | null; donateProceeds: boolean; hasPrintedTag: boolean; consignedAt: Date | null; deletedAt?: Date | null; updatedAt: Date; seller: (SellerNameRow & { id: string }) | null; photos: { id: string; url: string }[] }, inventoryMap: Map<string, number> | null, descriptions?: Map<string, ItemDescription>): ItemResponse {
    // Only an item in Square has stock to not know about. For everything else
    // the answer is a fact about our own row, whatever Square is doing.
    const inventoryKnown = inventoryMap !== null || !item.squareVariationId;
    // Unknown reads as unsold, not as sold out. Both are guesses; the first
    // sends a buyer to the floor to look, the second sends them home.
    const inStock = !inventoryKnown
      ? item.originalQuantity
      : item.squareVariationId ? (inventoryMap!.get(item.squareVariationId) ?? 0) : 0;
    return {
      id: item.id, swapId: item.swapId, orgId: item.orgId,
      name: item.name, description: item.description,
      sku: item.sku, priceCents: item.priceCents, originalQuantity: item.originalQuantity,
      inStock, soldCount: Math.max(0, item.originalQuantity - inStock),
      inventoryKnown,
      squareSynced: !!item.squareItemId && !!item.squareVariationId,
      donateProceeds: item.donateProceeds,
      hasPrintedTag: item.hasPrintedTag,
      // `ticketNumberOf` is the same parse the scan lookup uses, so there is one
      // definition of what a ticket number looks like rather than a second regex
      // here and a third in the web client.
      legacyTicket: ticketNumberOf(item.sku) !== null,
      consignedAt: item.consignedAt?.toISOString() ?? null,
      deletedAt: item.deletedAt?.toISOString() ?? null,
      seller: item.seller
        ? {
            id: item.seller.id,
            displayName: sellerDisplayName(item.seller) ?? 'Unnamed',
            phone: item.seller.membership.user.phone ?? null,
          }
        : null,
      photos: item.photos.map((p) => ({ id: p.id, url: p.url })),
      // Absent when the caller had no reason to fetch them — a photo upload's
      // response, say. An empty list reads the same as an item nobody described.
      category: descriptions?.get(item.id)?.category ?? null,
      attributes: descriptions?.get(item.id)?.attributes ?? [],
      updatedAt: item.updatedAt.toISOString(),
    };
  }
}

/**
 * What an item nobody described is called: its tag number (iOS Plan 20). The
 * same on the tag the iPad prints, in the web, and in Square, so an item can be
 * found by the one thing written on it.
 */
/**
 * A SKU the web made: neither a legacy ticket number nor a station's, which
 * carries its counter's letter (`SS26-A-0001`). What a shop prints its own
 * label for (Plan 31).
 */
export function isWebMadeSku(sku: string): boolean {
  return ticketNumberOf(sku) === null && stationCodeOf(sku) === null;
}

/** A ticket the fast edit found priced: refused, saying at what (Plan 37). */
function ticketPriced(sku: string, priceCents: number | null): ConflictException {
  const price = priceCents === null ? 'a price' : `a price ($${(priceCents / 100).toFixed(2)})`;
  return new ConflictException({ code: 'TICKET_PRICED', message: `${sku} already has ${price}.` });
}

// Lives with the SKU helpers so the ticket service can use it too; re-exported
// here for everything that has always imported it from this file.
export { uncategorisedName };
