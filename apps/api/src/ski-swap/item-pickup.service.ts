import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { displayName } from '../common/util/person';
import { PosAdapterFactory } from './pos/pos.adapter';
import { ItemService } from './item.service';
import { SELLER_NAME_INCLUDE, sellerDisplayName } from './seller.service';
import type { ItemResponse } from '../contracts/ski-swap.contracts';

/**
 * Sellers picking up their unsold items at the end of a swap (Plan 43; named
 * "pickup" in Plan 50, so it isn't mistaken for a sale's return).
 *
 * A pickup is a state of a live item, not a delete (D1): it stays on the
 * seller's record and on the iPads. It takes the item out of Square, so it
 * can't ring up after it has gone home (D3), and refuses one Square says has
 * sold, the guard against sending home something a buyer paid for (D2).
 */

/** Who marked it picked up: a staff member, or a staff check-in iPad. */
export interface PickupActor {
  type: 'user' | 'device';
  id: string;
}

export interface PickupResult {
  item: ItemResponse;
  /** `already_picked_up` is a double scan, not an error (D2). */
  outcome: 'picked_up' | 'already_picked_up';
  /** False when Square couldn't be read: picked up anyway, and said so (D2). */
  squareChecked: boolean;
}

/** A locked session's list (D5): the seller's items still out. */
export interface AwaitingPickupItem {
  id: string;
  sku: string;
  name: string;
  priceCents: number | null;
  /** Units still to go back; the item's quantity when Square couldn't be read. */
  units: number;
}

/** Device clocks drift; a scan stamped a little ahead of ours is still a scan. */
const CLOCK_SLACK_MS = 60_000;

const scopeOf = (orgId: string, swapId: string) => `item-pickup:${orgId}:${swapId}`;

@Injectable()
export class ItemPickupService {
  private readonly logger = new Logger(ItemPickupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
    private readonly items: ItemService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** The web scanner's path: the item by the SKU on its tag. */
  async pickUpBySku(orgId: string, swapId: string, sku: string, actor: PickupActor, opts: { sellerId?: string } = {}): Promise<PickupResult> {
    const item = await this.prisma.swapItem.findFirst({
      where: { orgId, swapId, liveSku: sku.trim(), deletedAt: null },
      select: { id: true },
    });
    if (!item) throw notFound();
    return this.pickUp(orgId, swapId, item.id, actor, opts);
  }

  /**
   * Picks up one item, the one path both routes take. Refusals: `ITEM_NOT_FOUND`,
   * `NOT_RECEIVED`, `WRONG_SELLER` (a locked session, D5), `ITEM_SOLD`.
   */
  async pickUp(
    orgId: string,
    swapId: string,
    itemId: string,
    actor: PickupActor,
    opts: { sellerId?: string; pickedUpAt?: string } = {},
    idempotencyKey?: string,
  ): Promise<PickupResult> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(scopeOf(orgId, swapId), idempotencyKey);
      if (cached) return cached as unknown as PickupResult;
    }
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true, locationId: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const item = await this.prisma.swapItem.findFirst({
      where: { id: itemId, orgId, swapId, deletedAt: null },
      include: { seller: { include: SELLER_NAME_INCLUDE } },
    });
    if (!item) throw notFound();

    if (opts.sellerId && item.sellerId !== opts.sellerId) {
      const owner = sellerDisplayName(item.seller) ?? 'another seller';
      const locked = await this.sellerName(orgId, opts.sellerId);
      throw new ConflictException({
        code: 'WRONG_SELLER',
        message: `This is ${possessive(owner)} item, not ${possessive(locked)}. Not picked up.`,
        details: { owner },
      });
    }
    if (item.pickedUpAt) return this.answer(orgId, swapId, itemId, 'already_picked_up', true, idempotencyKey);
    if (!item.consignedAt) {
      throw new ConflictException({ code: 'NOT_RECEIVED', message: 'Never accepted: it was never on sale. Not picked up.' });
    }

    // How many are still here, by Square's count (D2). Not in Square at all
    // is nothing sold; a count Square won't give is "couldn't check".
    const stock = await this.stockOf(orgId, swap.locationId, item.squareVariationId);
    if (stock.checked && stock.units < 1) {
      throw new ConflictException({ code: 'ITEM_SOLD', message: 'Square says this sold. It shouldn’t be in the pickup pile. Not picked up.' });
    }
    const units = stock.checked ? Math.min(stock.units, item.originalQuantity) : item.originalQuantity;

    const name = await this.actorName(actor);
    const at = this.stampOf(opts.pickedUpAt, item.consignedAt);
    // Conditional, so two iPads picking up the same item can't both win.
    const { count } = await this.prisma.swapItem.updateMany({
      where: { id: item.id, pickedUpAt: null, deletedAt: null },
      data: { pickedUpAt: at, pickedUpBy: actor.id, pickedUpByName: name, pickedUpUnits: units },
    });
    if (count === 0) return this.answer(orgId, swapId, itemId, 'already_picked_up', true, idempotencyKey);

    await this.audit(orgId, actor, 'ski_swap.item.picked_up', item.id, {
      sku: item.sku, sellerId: item.sellerId, units, squareChecked: stock.checked,
    });

    // Off sale (D3), after the record: the answer doesn't wait on Square, and
    // a refusal leaves the pickup standing for Catalog check to raise (D9).
    if (item.squareItemId) {
      void this.removeFromSquare(orgId, item.squareItemId).catch((err: unknown) =>
        this.logger.error({ err, itemId: item.id }, 'A picked-up item is still in Square'));
    }
    return this.answer(orgId, swapId, itemId, 'picked_up', stock.checked, idempotencyKey);
  }

  /**
   * Undoes a pickup (D4): back on sale as a new Square item. Refused for an
   * item with any units sold, whose new Square ids would orphan those sales.
   */
  async undo(orgId: string, swapId: string, itemId: string, actor: PickupActor): Promise<ItemResponse> {
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId, swapId, deletedAt: null } });
    if (!item) throw notFound();
    if (!item.pickedUpAt) throw new ConflictException({ code: 'NOT_PICKED_UP', message: 'This item hasn’t been picked up.' });
    if ((item.pickedUpUnits ?? item.originalQuantity) < item.originalQuantity) {
      throw new ConflictException({
        code: 'PARTLY_SOLD',
        message: 'Some of this item sold, so it can’t go back on sale as it was. Add the rest as a new item.',
      });
    }
    await this.prisma.swapItem.update({
      where: { id: item.id },
      data: { pickedUpAt: null, pickedUpBy: null, pickedUpByName: null, pickedUpUnits: null, squareItemId: null, squareVariationId: null },
    });
    await this.audit(orgId, actor, 'ski_swap.item.pickup_undone', item.id, { sku: item.sku, sellerId: item.sellerId });
    await this.items.syncToPos(orgId, swapId, item.id);
    return this.items.get(orgId, swapId, item.id);
  }

  /** The seller's items still out (D5): accepted, not picked up, with units left. */
  async awaitingPickup(orgId: string, swapId: string, sellerId: string): Promise<{ items: AwaitingPickupItem[]; squareChecked: boolean }> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { locationId: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const rows = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId, deletedAt: null, pickedUpAt: null, consignedAt: { not: null } },
      select: { id: true, sku: true, name: true, priceCents: true, originalQuantity: true, squareVariationId: true },
      orderBy: { sku: 'asc' },
    });
    const counts = await this.counts(orgId, swap.locationId, rows.map((r) => r.squareVariationId).filter((v): v is string => !!v));
    const items = rows
      .map((r) => {
        const n = r.squareVariationId && counts ? counts.get(r.squareVariationId) : undefined;
        return { id: r.id, sku: r.sku, name: r.name, priceCents: r.priceCents, units: n === undefined ? r.originalQuantity : Math.min(n, r.originalQuantity) };
      })
      .filter((r) => r.units >= 1);
    return { items, squareChecked: counts !== null };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async answer(
    orgId: string, swapId: string, itemId: string,
    outcome: PickupResult['outcome'], squareChecked: boolean, idempotencyKey?: string,
  ): Promise<PickupResult> {
    const result: PickupResult = { item: await this.items.get(orgId, swapId, itemId), outcome, squareChecked };
    if (idempotencyKey) {
      await this.idempotency.save(scopeOf(orgId, swapId), idempotencyKey, result as unknown as Record<string, unknown>);
    }
    return result;
  }

  /** Units in Square for one variation, or `checked: false` when Square couldn't say. */
  private async stockOf(orgId: string, locationId: string, variationId: string | null): Promise<{ checked: boolean; units: number }> {
    // Never in Square: nothing can have sold.
    if (!variationId) return { checked: true, units: Number.POSITIVE_INFINITY };
    const counts = await this.counts(orgId, locationId, [variationId]);
    const n = counts?.get(variationId);
    return n === undefined ? { checked: false, units: 0 } : { checked: true, units: n };
  }

  private async counts(orgId: string, locationId: string, variationIds: string[]): Promise<Map<string, number> | null> {
    if (variationIds.length === 0) return new Map();
    if (!locationId) return null;
    try {
      const pos = await this.posFactory.forOrg(orgId);
      return pos ? await pos.getInventoryCounts(variationIds, locationId) : null;
    } catch (err) {
      this.logger.warn({ err, orgId }, 'Square inventory read failed during a pickup');
      return null;
    }
  }

  private async removeFromSquare(orgId: string, squareItemId: string): Promise<void> {
    const pos = await this.posFactory.forOrg(orgId);
    if (pos) await pos.deleteItem(squareItemId);
  }

  /**
   * When the pickup happened (D7): a device's own stamp when it falls between
   * the item's acceptance and now, a scan made offline and sent later; ours
   * otherwise.
   */
  private stampOf(claimed: string | undefined, consignedAt: Date): Date {
    const now = new Date();
    if (!claimed) return now;
    const at = new Date(claimed);
    if (Number.isNaN(at.getTime()) || at < consignedAt || at.getTime() > now.getTime() + CLOCK_SLACK_MS) return now;
    return at > now ? now : at;
  }

  private async actorName(actor: PickupActor): Promise<string | null> {
    if (actor.type === 'device') {
      return (await this.prisma.device.findUnique({ where: { id: actor.id }, select: { name: true } }))?.name ?? null;
    }
    const user = await this.prisma.user.findUnique({ where: { id: actor.id }, select: { firstName: true, lastName: true, email: true, phone: true } });
    return user ? displayName(user) : null;
  }

  private async sellerName(orgId: string, sellerId: string): Promise<string> {
    const seller = await this.prisma.sellerProfile.findFirst({ where: { id: sellerId, membership: { orgId } }, include: SELLER_NAME_INCLUDE });
    return sellerDisplayName(seller) ?? 'the chosen seller';
  }

  private audit(orgId: string, actor: PickupActor, action: string, itemId: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: { actorType: actor.type, actorId: actor.id, orgId, action, targetType: 'swap_item', targetId: itemId, metadata: metadata as object },
    });
  }
}

/** "Little Mountain’s", "Geigers’". */
const possessive = (name: string) => (name.endsWith('s') ? `${name}’` : `${name}’s`);

const notFound = () => new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'No item has this SKU in this swap.' });
