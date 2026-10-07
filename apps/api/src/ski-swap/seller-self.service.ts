import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ItemListView } from './item-list-order';
import { PrismaService } from '../prisma/prisma.service';
import { ItemService } from './item.service';
import type { SellerResponse } from '../contracts/ski-swap.contracts';
import { SellerService } from './seller.service';
import { PrintQueueService } from './print-queue.service';
import { SkiSwapSettingsService } from './ski-swap-settings.service';
import type { ImportGuideFile } from './import-guide';
import { isUntouched, LegacyTicketService, ticketNumberOf, type ImportFileRow, type TicketFields } from './legacy-ticket.service';
import type { ItemAttributeInput } from './taxonomy/taxonomy.service';

@Injectable()
export class SellerSelfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly itemService: ItemService,
    private readonly sellerService: SellerService,
    private readonly printQueue: PrintQueueService,
    private readonly settings: SkiSwapSettingsService,
    private readonly tickets: LegacyTicketService,
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
    // A seller's own pages can't scan a Venmo code; only the staff iPad can (Plan 35).
    if (data.payoutHandleSource) {
      throw new BadRequestException('A Venmo account is set by scanning your Venmo code at the swap.');
    }
    // A business seller may not rename their own business; staff own that field.
    const { businessName: _ignored, ...safe } = data;
    return this.sellerService.patch(orgId, existing.id, safe);
  }

  // ─── Active swaps (for swap selector) ────────────────────────────────────

  async listActiveSwaps(orgId: string, userId: string): Promise<{ id: string; title: string; labelsPerItem: number }[]> {
    // An individual sees only swaps with Authenticated Seller Status on; a
    // shop, which manages its own inventory, sees every one (Plan 33).
    const seller = await this.getSellerRecord(orgId, userId);
    const swaps = await this.prisma.skiSwap.findMany({
      where: { orgId, active: true, ...(seller.businessName ? {} : { sellerLoginEnabled: true }) },
      // `labelsPerItem` because a business seller prints its own tags, as
      // many per item as the swap asks for.
      select: { id: true, title: true, labelsPerItem: true },
      orderBy: { createdAt: 'desc' },
    });
    return swaps;
  }

  // ─── Items ────────────────────────────────────────────────────────────────

  async listItems(orgId: string, userId: string, swapId?: string, page: { skip?: number; take?: number } & ItemListView = {}) {
    const seller = await this.getSellerRecord(orgId, userId);

    // When no swapId given, collect items from all active swaps
    if (!swapId) {
      const activeSwaps = await this.prisma.skiSwap.findMany({
        where: { orgId, active: true },
        select: { id: true },
      });
      const results = await Promise.all(
        activeSwaps.map((s) =>
          this.itemService.list(orgId, s.id, { sellerId: seller.id, ...page }),
        ),
      );
      const items = results.flatMap((r) => r.items);
      return { items, total: results.reduce((n, r) => n + r.total, 0) };
    }

    // `skip`/`take` pass straight through. Without them a shop that imported
    // two hundred items saw the list's default page of fifty and no more.
    return this.itemService.list(orgId, swapId, { sellerId: seller.id, ...page });
  }

  async getItem(orgId: string, userId: string, itemId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Item not found');
    if (item.sellerId !== seller.id) throw new ForbiddenException('Not your item');
    return this.itemService.get(orgId, item.swapId, itemId);
  }

  /** A download beside the shop's upload (Plan 42 D12). Shops only, as the upload is. */
  async importGuide(orgId: string, userId: string, file: ImportGuideFile) {
    const seller = await this.getSellerRecord(orgId, userId);
    if (!seller.businessName) throw new ForbiddenException('Only a shop can upload its items from a file.');
    return this.itemService.importGuide(orgId, file);
  }

  /**
   * The signed-in seller's own inventory, from a file they uploaded.
   *
   * Thin on purpose: the rules are `LegacyTicketService`'s and the writes are
   * `ItemService`'s, and this only says whose items they are.
   */
  async importItems(
    orgId: string,
    userId: string,
    swapId: string,
    file: { headers: string[]; rows: ImportFileRow[] },
    opts: { generateSkus?: boolean; acceptUnknown?: boolean } = {},
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    if (!seller.businessName) throw new ForbiddenException('Only a shop can upload its items from a file.');
    // The shop's own file: a list of what they mean to bring, none of which
    // anybody has seen. It waits for staff like everything else they enter.
    return this.itemService.importItems(orgId, swapId, seller.id, file.rows, {
      selfService: true,
      generateSkus: opts.generateSkus,
      headers: file.headers,
      acceptUnknown: opts.acceptUnknown,
    });
  }

  /**
   * Saves an item for the signed-in seller.
   *
   * The station half — which counter's code namespaces the SKU, whether a tag is
   * queued — lives in `ItemService.createAtStation`, because the staff path needs
   * exactly the same rules and two copies would drift.
   */
  async createItem(
    orgId: string,
    userId: string,
    data: {
      swapId: string;
      categoryId?: string;
      attributes?: ItemAttributeInput[];
      description?: string;
      /** None only for a legacy ticket (Plan 32); `ItemService.create` decides. */
      priceCents?: number | null;
      quantity: number;
      donateProceeds?: boolean;
      stationId?: string;
      sku?: string;
      generateSku?: boolean;
    },
    idempotencyKey?: string,
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    // An individual adds items only while checking in, at a station, from its
    // QR code. A shop also adds them from its own desk.
    if (!seller.businessName && !data.stationId) {
      throw new ForbiddenException('Add items when you check in at the swap, by scanning its check-in QR code.');
    }
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: data.swapId, orgId, active: true } });
    if (!swap) throw new NotFoundException('Active swap not found');

    // Blocks count on the web only where the web takes legacy tickets (Plan 34),
    // and only for a shop: an individual's loose ticket, checked in at the
    // counter, is theirs too, but they add items at a station, not on tickets.
    const holdsTickets = !!seller.businessName && swap.allowLegacyWeb
      && (await this.tickets.isLegacySeller(data.swapId, seller.id));

    // With no print tickets on the web, every item entered here is a legacy
    // ticket: a seller with no block has nothing to enter it on, and none may
    // ask for a generated SKU. With print tickets too, a seller who holds
    // tickets may still ask for one, for an item they will print a label for.
    if (data.generateSku && data.sku !== undefined) {
      throw new BadRequestException('Give a ticket number or ask for a generated SKU, not both.');
    }
    if (!swap.allowPrintWeb) {
      if (data.generateSku) {
        throw new BadRequestException('This swap takes legacy tickets only, so SKUs can’t be generated.');
      }
      if (!holdsTickets) {
        throw new BadRequestException(
          'This swap takes legacy tickets only. Ask the organizer for a block of tickets.',
        );
      }
    }
    const onTickets = holdsTickets && !data.generateSku;

    // A ticket number is honoured only from a seller who holds one. Accepting
    // it from anyone else would let them mint a SKU that collides with the
    // counter's sequence.
    if (data.sku !== undefined && !onTickets) {
      throw new BadRequestException(
        swap.allowLegacyWeb ? 'This seller does not use issued tickets.' : 'This swap doesn’t take legacy tickets on the web.',
      );
    }

    /*
     * On tickets, an "add" fills in one of the shop's issued tickets (Plan 38
     * D7): every number it holds already exists, from the moment it was
     * issued. The number given, or the lowest nobody has described yet. A
     * shop fills each in once (D6); after that, it's staff's to change.
     */
    if (onTickets) {
      const sku = data.sku?.trim() || (await this.lowestUntouched(data.swapId, seller.id));
      const ticket = await this.tickets.ownTicket(data.swapId, seller.id, sku);
      await this.assertShopMayDescribe(orgId, data.swapId, ticket);
      return this.itemService.patch(
        orgId,
        data.swapId,
        ticket.id,
        {
          ...(data.categoryId ? { categoryId: data.categoryId, attributes: data.attributes ?? [] } : {}),
          ...(data.description ? { description: data.description } : {}),
          ...(data.priceCents != null ? { priceCents: data.priceCents } : {}),
          ...(data.donateProceeds !== undefined ? { donateProceeds: data.donateProceeds } : {}),
          actorId: userId,
        },
        idempotencyKey,
      );
    }
    if (!data.categoryId) throw new BadRequestException('Pick what the item is.');

    return this.itemService.createAtStation(
      orgId,
      data.swapId,
      {
        ...data,
        sellerId: seller.id,
        // Whoever typed a new value owns it in the approval queue.
        actorId: userId,
        // Nobody else is in this path — a seller entering their own things.
        // Whether that means waiting for a scan is `createAtStation`'s to
        // decide; it also needs a station, and that rule lives with it rather
        // than being spelled twice.
        selfService: true,
      },
      idempotencyKey,
    );
  }

  /** The lowest of the shop's tickets nobody has described, for an add with no number. */
  private async lowestUntouched(swapId: string, sellerId: string): Promise<string> {
    const { suggested, exhausted } = await this.tickets.formState(swapId, sellerId);
    if (suggested === null) {
      throw new ConflictException(
        exhausted
          ? 'All of your tickets are described. Ask the swap’s staff to change one, or for more tickets.'
          : 'You have no tickets for this swap. Ask the organizer for a block.',
      );
    }
    return String(suggested);
  }

  /**
   * A shop fills in its ticket once (Plan 38 D6): while nobody has described or
   * priced it, and it hasn't sold. After that it's staff's to change.
   */
  private async assertShopMayDescribe(orgId: string, swapId: string, ticket: TicketFields & { id: string }) {
    if (!isUntouched(ticket)) {
      throw new ConflictException({
        message: `${ticket.sku} is already described. Ask the swap’s staff to change it.`,
        code: 'TICKET_DESCRIBED',
      });
    }
    await this.assertUnsold(orgId, swapId, ticket);
  }

  private async assertUnsold(orgId: string, swapId: string, ticket: { id: string; sku: string }) {
    if ((await this.itemService.soldAmong(orgId, swapId, [ticket.id])).size) {
      throw new ConflictException({
        message: `${ticket.sku} has sold. Ask the swap’s staff to change it.`,
        code: 'TICKET_SOLD',
      });
    }
  }

  /**
   * Re-queues one item's tags, for a tag that jammed or came out unreadable.
   * The only path that deliberately prints an item twice.
   */
  async reprintItem(orgId: string, userId: string, itemId: string, stationId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    await this.requireOwnership(orgId, seller.id, itemId);
    await this.printQueue.reprintItem(orgId, stationId, itemId);
    return { queued: true };
  }

  /**
   * A seller editing their own item.
   *
   * Until it is accepted for sale, anything. After, nothing — the same line as
   * `deleteItem`. An accepted item is live at the register under a tag staff
   * have checked, and changes to it are made at the counter, where somebody can
   * see the gear and reprint the tag: a new price typed on a phone would ring
   * up against a tag that says otherwise, and a quantity reset on something
   * already sold would put it back in stock.
   *
   * The one thing still accepted is `hasPrintedTag`, which the web sets itself
   * after printing a tag. It records that a tag came out, not anything about
   * the item.
   */
  async updateItem(
    orgId: string,
    userId: string,
    itemId: string,
    data: {
      categoryId?: string;
      attributes?: ItemAttributeInput[];
      description?: string | null;
      priceCents?: number;
      quantity?: number;
      donateProceeds?: boolean;
      hasPrintedTag?: boolean;
    },
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    this.assertMayChangeItems(seller);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, deletedAt: null } });
    const editsItem = Object.entries(data).some(([key, value]) => key !== 'hasPrintedTag' && value !== undefined);
    if (editsItem) {
      // An issued ticket is accepted from the start, so it's held to "once,
      // while untouched and unsold" instead (Plan 38 D6).
      if (item.consignedAt !== null && ticketNumberOf(item.sku) !== null) await this.assertShopMayDescribe(orgId, item.swapId, item);
      else this.assertNotAccepted(item);
    }
    // The seller is the actor: printing a label for an item whose SKU the web
    // made accepts it (Plan 31), and that acceptance is theirs.
    return this.itemService.patch(orgId, item.swapId, itemId, { ...data, actorId: userId });
  }

  /**
   * A seller withdrawing their own item.
   *
   * Allowed until the item is consigned, refused afterwards. `consignedAt` is
   * the moment an item becomes sellable — it is set in the same breath as the
   * push to Square on every path — so this is the line between gear the seller
   * still effectively holds and gear that is live at a register.
   *
   * Two paths stamp it at creation: a staff check-in, and a station self
   * check-in at an org that does not require a scan. Two leave it null until
   * staff accept the item: a station self check-in at an org running
   * `requireConsignmentScan`, and anything a seller enters or uploads away from
   * a station, such as a shop's inventory. Until then the seller may take a row
   * back out.
   *
   * After that it is staff work — rare, and done at the counter, where somebody
   * can see both the gear and the tag. That is the thing a seller on their phone
   * cannot do, which is the whole reason for the split.
   */
  async deleteItem(orgId: string, userId: string, itemId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    this.assertMayChangeItems(seller);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, deletedAt: null } });

    if (item.consignedAt !== null) {
      throw new ConflictException(
        `${item.name} has already been accepted for sale, so it has to be withdrawn ` +
          'at the counter. Ask a staff member and they can remove it for you.',
      );
    }

    return this.itemService.remove(orgId, item.swapId, itemId);
  }

  async uploadPhoto(
    orgId: string,
    userId: string,
    itemId: string,
    file: { buffer: Buffer; mimetype: string; originalname: string },
    stationId?: string,
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    // Check-in photographs each item just after adding it, from the station.
    if (!stationId || !(await this.isStation(orgId, stationId))) this.assertMayChangeItems(seller);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, deletedAt: null } });
    await this.assertMayChangePhotos(orgId, item);
    return this.itemService.uploadPhoto(orgId, item.swapId, itemId, file);
  }

  async deletePhoto(orgId: string, userId: string, itemId: string, photoId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    this.assertMayChangeItems(seller);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, deletedAt: null } });
    await this.assertMayChangePhotos(orgId, item);
    return this.itemService.deletePhoto(orgId, item.swapId, itemId, photoId);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * An individual's items are read-only outside check-in: they enter them at
   * a station, from its QR code, and changes after that are made by staff. A
   * shop manages its own from its desk.
   */
  private assertMayChangeItems(seller: { businessName: string | null }) {
    if (!seller.businessName) {
      throw new ForbiddenException('Your items can only be changed by staff at the swap.');
    }
  }

  private async isStation(orgId: string, stationId: string) {
    const station = await this.prisma.checkinStation.findFirst({ where: { id: stationId, orgId, deletedAt: null }, select: { id: true } });
    return !!station;
  }

  /**
   * Photos: a shop's own ticket takes them until it sells (Plan 38), since the
   * form adds them just after the ticket is described. Anything else accepted
   * is staff's, as before.
   */
  private async assertMayChangePhotos(orgId: string, item: { id: string; sku: string; swapId: string; name: string; consignedAt: Date | null }) {
    if (item.consignedAt !== null && ticketNumberOf(item.sku) !== null) return this.assertUnsold(orgId, item.swapId, item);
    this.assertNotAccepted(item);
  }

  /** Edits to an accepted item are staff work, made at the counter (see `updateItem`). */
  private assertNotAccepted(item: { name: string; consignedAt: Date | null }) {
    if (item.consignedAt === null) return;
    throw new ConflictException({
      message:
        `${item.name} has already been accepted for sale, so it can only be changed at the counter. ` +
        'Ask a staff member and they can change it for you.',
      code: 'ITEM_ACCEPTED',
    });
  }

  private async requireOwnership(orgId: string, sellerId: string, itemId: string) {
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId, deletedAt: null } });
    if (!item) throw new NotFoundException('Item not found');
    if (item.sellerId !== sellerId) throw new ForbiddenException('Not your item');
  }
}

