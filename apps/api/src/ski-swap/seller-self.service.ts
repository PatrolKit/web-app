import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ItemService } from './item.service';
import type { SellerResponse } from '../contracts/ski-swap.contracts';
import { SellerService } from './seller.service';
import { PrintQueueService } from './print-queue.service';
import { SkiSwapSettingsService } from './ski-swap-settings.service';
import { LegacyTicketService } from './legacy-ticket.service';
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
    // A business seller may not rename their own business; staff own that field.
    const { businessName: _ignored, ...safe } = data;
    return this.sellerService.patch(orgId, existing.id, safe);
  }

  // ─── Active swaps (for swap selector) ────────────────────────────────────

  async listActiveSwaps(orgId: string): Promise<{ id: string; title: string; labelsPerItem: number }[]> {
    const swaps = await this.prisma.skiSwap.findMany({
      where: { orgId, active: true },
      // `labelsPerItem` because a business seller prints its own tags, as
      // many per item as the swap asks for.
      select: { id: true, title: true, labelsPerItem: true },
      orderBy: { createdAt: 'desc' },
    });
    return swaps;
  }

  // ─── Items ────────────────────────────────────────────────────────────────

  async listItems(orgId: string, userId: string, swapId?: string, page: { skip?: number; take?: number } = {}) {
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
    rows: { sku: string; name?: string; description?: string; priceCents: number }[],
    generateSkus = false,
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    // The shop's own file: a list of what they mean to bring, none of which
    // anybody has seen. It waits for staff like everything else they enter.
    return this.itemService.importItems(orgId, swapId, seller.id, rows, {
      selfService: true,
      generateSkus,
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
      priceCents: number;
      quantity: number;
      donateProceeds?: boolean;
      stationId?: string;
      sku?: string;
      generateSku?: boolean;
    },
    idempotencyKey?: string,
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: data.swapId, orgId, active: true } });
    if (!swap) throw new NotFoundException('Active swap not found');

    const holdsTickets = await this.tickets.isLegacySeller(data.swapId, seller.id);

    // Plan 31. With the swap's web on tickets only, every item entered here is
    // one: a seller with no block has nothing to enter it on, and none may ask
    // for a generated SKU. Off, a seller who holds tickets may still ask for
    // one, for an item they will print a label for.
    if (data.generateSku && data.sku !== undefined) {
      throw new BadRequestException('Give a ticket number or ask for a generated SKU, not both.');
    }
    if (swap.webLegacyTicketsOnly) {
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
      throw new BadRequestException('This seller does not use issued tickets.');
    }

    // Described through the tree is the ordinary path now (Plan 19). A ticket
    // seller may still list something it says nothing about, and then it is
    // called by its number, `Item #<sku>`, like any uncategorised item.
    let sku: string | undefined;

    if (onTickets) {
      if (data.sku) {
        sku = data.sku.trim();
        await this.tickets.assertUsable(data.swapId, seller.id, sku);
      } else {
        // No number given: take the suggestion, and refuse only when there is
        // genuinely nothing unused left rather than merely nothing to suggest.
        await this.tickets.assertNotExhausted(data.swapId, seller.id);
        const { suggested } = await this.tickets.formState(data.swapId, seller.id);
        if (suggested === null) {
          throw new BadRequestException(
            'You have worked to the end of your tickets. Enter the number of a skipped one.',
          );
        }
        sku = String(suggested);
        await this.tickets.assertUsable(data.swapId, seller.id, sku);
      }
    } else if (!data.categoryId) {
      throw new BadRequestException('Pick what the item is.');
    }

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
        ...(sku ? { sku, alreadyPrinted: true } : {}),
      },
      idempotencyKey,
    );
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
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, deletedAt: null } });
    const editsItem = Object.entries(data).some(([key, value]) => key !== 'hasPrintedTag' && value !== undefined);
    if (editsItem) this.assertNotAccepted(item);
    return this.itemService.patch(orgId, item.swapId, itemId, data);
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
  ) {
    const seller = await this.getSellerRecord(orgId, userId);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, deletedAt: null } });
    this.assertNotAccepted(item);
    return this.itemService.uploadPhoto(orgId, item.swapId, itemId, file);
  }

  async deletePhoto(orgId: string, userId: string, itemId: string, photoId: string) {
    const seller = await this.getSellerRecord(orgId, userId);
    await this.requireOwnership(orgId, seller.id, itemId);
    const item = await this.prisma.swapItem.findFirstOrThrow({ where: { id: itemId, orgId, deletedAt: null } });
    this.assertNotAccepted(item);
    return this.itemService.deletePhoto(orgId, item.swapId, itemId, photoId);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

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

