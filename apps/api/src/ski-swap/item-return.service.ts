import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { displayName } from '../common/util/person';
import { PosAdapterFactory } from './pos/pos.adapter';
import { ItemService } from './item.service';
import { SELLER_NAME_INCLUDE, sellerDisplayName } from './seller.service';
import type { ItemResponse } from '../contracts/ski-swap.contracts';

/**
 * Handing unsold items back to their sellers (Plan 43).
 *
 * A return is a state of a live item, not a delete (D1): it stays on the
 * seller's record and on the iPads. It takes the item out of Square, so it
 * can't ring up after it has gone home (D3), and refuses one Square says has
 * sold, the guard against handing back something a buyer paid for (D2).
 */

/** Who handed it back: a staff member, or a staff check-in iPad. */
export interface ReturnActor {
  type: 'user' | 'device';
  id: string;
}

export interface ReturnResult {
  item: ItemResponse;
  /** `already_returned` is a double scan, not an error (D2). */
  outcome: 'returned' | 'already_returned';
  /** False when Square couldn't be read: returned anyway, and said so (D2). */
  squareChecked: boolean;
}

/** A locked session's list (D5): the seller's items still out. */
export interface UnreturnedItem {
  id: string;
  sku: string;
  name: string;
  priceCents: number | null;
  /** Units still to go back; the item's quantity when Square couldn't be read. */
  units: number;
}

/** Device clocks drift; a scan stamped a little ahead of ours is still a scan. */
const CLOCK_SLACK_MS = 60_000;

const scopeOf = (orgId: string, swapId: string) => `item-return:${orgId}:${swapId}`;

@Injectable()
export class ItemReturnService {
  private readonly logger = new Logger(ItemReturnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posFactory: PosAdapterFactory,
    private readonly items: ItemService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** The web scanner's path: the item by the SKU on its tag. */
  async returnBySku(orgId: string, swapId: string, sku: string, actor: ReturnActor, opts: { sellerId?: string } = {}): Promise<ReturnResult> {
    const item = await this.prisma.swapItem.findFirst({
      where: { orgId, swapId, liveSku: sku.trim(), deletedAt: null },
      select: { id: true },
    });
    if (!item) throw notFound();
    return this.returnItem(orgId, swapId, item.id, actor, opts);
  }

  /**
   * Returns one item, the one path both routes take. Refusals: `ITEM_NOT_FOUND`,
   * `NOT_RECEIVED`, `WRONG_SELLER` (a locked session, D5), `ITEM_SOLD`.
   */
  async returnItem(
    orgId: string,
    swapId: string,
    itemId: string,
    actor: ReturnActor,
    opts: { sellerId?: string; returnedAt?: string } = {},
    idempotencyKey?: string,
  ): Promise<ReturnResult> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(scopeOf(orgId, swapId), idempotencyKey);
      if (cached) return cached as unknown as ReturnResult;
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
        message: `This is ${possessive(owner)} item, not ${possessive(locked)}. Not returned.`,
        details: { owner },
      });
    }
    if (item.returnedAt) return this.answer(orgId, swapId, itemId, 'already_returned', true, idempotencyKey);
    if (!item.consignedAt) {
      throw new ConflictException({ code: 'NOT_RECEIVED', message: 'Never accepted: it was never on sale. Not returned.' });
    }

    // How many are still here, by Square's count (D2). Not in Square at all
    // is nothing sold; a count Square won't give is "couldn't check".
    const stock = await this.stockOf(orgId, swap.locationId, item.squareVariationId);
    if (stock.checked && stock.units < 1) {
      throw new ConflictException({ code: 'ITEM_SOLD', message: 'Square says this sold. It shouldn’t be in the return pile. Not returned.' });
    }
    const units = stock.checked ? Math.min(stock.units, item.originalQuantity) : item.originalQuantity;

    const name = await this.actorName(actor);
    const at = this.stampOf(opts.returnedAt, item.consignedAt);
    // Conditional, so two iPads returning the same item can't both win.
    const { count } = await this.prisma.swapItem.updateMany({
      where: { id: item.id, returnedAt: null, deletedAt: null },
      data: { returnedAt: at, returnedBy: actor.id, returnedByName: name, returnedUnits: units },
    });
    if (count === 0) return this.answer(orgId, swapId, itemId, 'already_returned', true, idempotencyKey);

    await this.audit(orgId, actor, 'ski_swap.item.returned', item.id, {
      sku: item.sku, sellerId: item.sellerId, units, squareChecked: stock.checked,
    });

    // Off sale (D3), after the record: the answer doesn't wait on Square, and
    // a refusal leaves the return standing for Diagnostics to raise (D9).
    if (item.squareItemId) {
      void this.removeFromSquare(orgId, item.squareItemId).catch((err: unknown) =>
        this.logger.error({ err, itemId: item.id }, 'A returned item is still in Square'));
    }
    return this.answer(orgId, swapId, itemId, 'returned', stock.checked, idempotencyKey);
  }

  /**
   * Undoes a return (D4): back on sale as a new Square item. Refused for an
   * item with any units sold, whose new Square ids would orphan those sales.
   */
  async undo(orgId: string, swapId: string, itemId: string, actor: ReturnActor): Promise<ItemResponse> {
    const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, orgId, swapId, deletedAt: null } });
    if (!item) throw notFound();
    if (!item.returnedAt) throw new ConflictException({ code: 'NOT_RETURNED', message: 'This item hasn’t been returned.' });
    if ((item.returnedUnits ?? item.originalQuantity) < item.originalQuantity) {
      throw new ConflictException({
        code: 'PARTLY_SOLD',
        message: 'Some of this item sold, so it can’t go back on sale as it was. Add the rest as a new item.',
      });
    }
    await this.prisma.swapItem.update({
      where: { id: item.id },
      data: { returnedAt: null, returnedBy: null, returnedByName: null, returnedUnits: null, squareItemId: null, squareVariationId: null },
    });
    await this.audit(orgId, actor, 'ski_swap.item.return_undone', item.id, { sku: item.sku, sellerId: item.sellerId });
    await this.items.syncToPos(orgId, swapId, item.id);
    return this.items.get(orgId, swapId, item.id);
  }

  /** The seller's items still out (D5): accepted, not returned, with units left. */
  async unreturned(orgId: string, swapId: string, sellerId: string): Promise<{ items: UnreturnedItem[]; squareChecked: boolean }> {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { locationId: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    const rows = await this.prisma.swapItem.findMany({
      where: { orgId, swapId, sellerId, deletedAt: null, returnedAt: null, consignedAt: { not: null } },
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
    outcome: ReturnResult['outcome'], squareChecked: boolean, idempotencyKey?: string,
  ): Promise<ReturnResult> {
    const result: ReturnResult = { item: await this.items.get(orgId, swapId, itemId), outcome, squareChecked };
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
      this.logger.warn({ err, orgId }, 'Square inventory read failed during a return');
      return null;
    }
  }

  private async removeFromSquare(orgId: string, squareItemId: string): Promise<void> {
    const pos = await this.posFactory.forOrg(orgId);
    if (pos) await pos.deleteItem(squareItemId);
  }

  /**
   * When the return happened (D7): a device's own stamp when it falls between
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

  private async actorName(actor: ReturnActor): Promise<string | null> {
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

  private audit(orgId: string, actor: ReturnActor, action: string, itemId: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: { actorType: actor.type, actorId: actor.id, orgId, action, targetType: 'swap_item', targetId: itemId, metadata: metadata as object },
    });
  }
}

/** "Little Mountain’s", "Geigers’". */
const possessive = (name: string) => (name.endsWith('s') ? `${name}’` : `${name}’s`);

const notFound = () => new NotFoundException({ code: 'ITEM_NOT_FOUND', message: 'No item has this SKU in this swap.' });
