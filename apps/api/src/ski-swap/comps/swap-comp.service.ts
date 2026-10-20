import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { PosAdapterFactory } from '../pos/pos.adapter';
import { ItemBreakdownService } from '../item-breakdown.service';
import { ItemService } from '../item.service';
import { sellerDisplayName, SELLER_NAME_INCLUDE } from '../seller.service';
import { COMP_ORDER_PREFIX } from '../sales-check';
import type { CompReason, CompsResponse, CompView } from '../../contracts/comps.contracts';
import { itemComp } from './live-comps';
import { NOT_PAID_STATUSES } from '../../contracts/payouts.contracts';

/**
 * Comps (Plan 53): an item marked sold with no trace of selling in Square, so
 * its seller is paid the list price. The comp is read alongside Square's sales
 * wherever they're attributed to items (`attributeSales`), so it counts as sold
 * everywhere at once; Square's stock goes to zero so the register can't sell
 * it again (D5). Staff see "Comped"; customers see "Sold" (D6).
 */
@Injectable()
export class SwapCompService {
  private readonly logger = new Logger(SwapCompService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pos: PosAdapterFactory,
    private readonly breakdown: ItemBreakdownService,
    private readonly items: ItemService,
    private readonly idempotency: IdempotencyService,
  ) {}

  /** Adjustments → Comps (D10): every comp of the swap, newest first, with the live total. */
  async list(orgId: string, swapId: string): Promise<CompsResponse> {
    await this.swapOrThrow(orgId, swapId);
    const rows = await this.prisma.swapComp.findMany({ where: { swapId }, orderBy: { compedAt: 'desc' } });
    if (!rows.length) return { comps: [], live: { count: 0, totalCents: 0 } };
    const items = await this.prisma.swapItem.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.itemId))] } },
      select: { id: true, sku: true, name: true, deletedAt: true, seller: { select: { id: true, ...SELLER_NAME_INCLUDE, businessName: true } } },
    });
    const byId = new Map(items.map((i) => [i.id, i]));
    const names = await this.userNames([...rows.map((r) => r.compedBy), ...rows.map((r) => r.undoneBy)]);
    const paid = await this.paidComps(rows.map((r) => r.id));
    const comps: CompView[] = rows.map((r) => {
      const item = byId.get(r.itemId);
      return {
        ...itemComp(r),
        item: { id: r.itemId, sku: item?.sku ?? '?', name: item?.name ?? 'An item no longer in this swap', deleted: !item || !!item.deletedAt },
        seller: item?.seller ? { id: item.seller.id, name: sellerDisplayName(item.seller) ?? 'Unnamed seller' } : null,
        compedByName: r.compedBy ? names.get(r.compedBy) ?? null : null,
        undone: r.undoneAt ? { at: r.undoneAt.toISOString(), by: r.undoneBy, byName: r.undoneBy ? names.get(r.undoneBy) ?? null : null, note: r.undoNote } : null,
        paid: paid.has(r.id),
      };
    });
    const live = rows.filter((r) => r.liveKey);
    return { comps, live: { count: live.reduce((n, r) => n + r.units, 0), totalCents: live.reduce((n, r) => n + r.units * r.priceCents, 0) } };
  }

  /**
   * Comps an item (D2–D5): only one with units Square shows unsold, consigned,
   * and neither picked up nor deleted. Always the list price; an unpriced
   * item is priced first.
   */
  async create(
    orgId: string, swapId: string, itemId: string,
    body: { reason: CompReason; note: string; priceCents?: number; units: number },
    actorId: string, key?: string,
  ) {
    return this.once(orgId, swapId, `create:${itemId}`, key, async () => {
      const swap = await this.swapOrThrow(orgId, swapId);
      const item = await this.prisma.swapItem.findFirst({ where: { id: itemId, swapId, orgId } });
      if (!item || item.deletedAt) throw new NotFoundException('That item isn’t in this swap.');
      if (!item.consignedAt) throw new ConflictException(`${item.sku} was never checked in, so it can’t have sold.`);
      if (item.pickedUpAt) throw new ConflictException(`${item.sku} was picked up by its seller, so it can’t be comped.`);
      if (!item.squareVariationId) throw new ConflictException(`${item.sku} isn’t in Square, so a comp couldn’t count as its sale.`);
      if (!swap.locationId) throw new BadRequestException('This swap has no Square location.');

      // Square read afresh: an item Square shows sold goes through Sales check instead (D2).
      this.breakdown.forgetSales(swapId);
      const sold = (await this.breakdown.soldUnits(orgId, swapId)).get(item.squareVariationId) ?? 0;
      const unsold = Math.max(0, item.originalQuantity - sold);
      if (unsold === 0) throw new ConflictException(`${item.sku} already counts as sold. If its sale is on the wrong ticket, fix it in Sales check.`);
      if (body.units > unsold) throw new ConflictException(`${item.sku} has ${unsold} unsold, so ${body.units} can’t be comped.`);

      // D4: always the list price. A priced item takes no other; an unpriced one is priced first.
      let priceCents = item.priceCents;
      if (priceCents !== null && body.priceCents !== undefined && body.priceCents !== priceCents) {
        throw new BadRequestException(`A comp is always the list price: ${item.sku} is $${(priceCents / 100).toFixed(2)}.`);
      }
      if (priceCents === null) {
        if (body.priceCents === undefined) throw new BadRequestException(`${item.sku} has no price. Enter one: it becomes its list price.`);
        await this.items.patch(orgId, swapId, itemId, { priceCents: body.priceCents, ifUnpriced: true, actorId });
        priceCents = body.priceCents;
      }

      const id = (await this.prisma.swapComp.create({
        data: { swapId, orgId, itemId, units: body.units, priceCents, reason: body.reason, note: body.note, compedBy: actorId },
        select: { id: true },
      })).id;
      await this.prisma.swapComp.update({ where: { id }, data: { liveKey: id } });

      // D5: Square's stock to what's left, so the register can't sell it again.
      const stock = Math.max(0, unsold - body.units);
      let stockError: string | undefined;
      try {
        const pos = await this.pos.forOrg(orgId);
        if (!pos) throw new Error('Square isn’t connected.');
        await pos.setInventoryPhysicalCount(item.squareVariationId, swap.locationId, stock);
      } catch (err) {
        stockError = err instanceof Error ? err.message : 'Square’s stock couldn’t be set.';
        this.logger.warn({ err, itemId }, 'Comp recorded, but Square’s stock was not set');
      }
      this.breakdown.forgetSales(swapId);
      await this.audit(orgId, actorId, 'ski_swap.comp.created', { swapId, compId: id, itemId, sku: item.sku, units: body.units, priceCents, reason: body.reason, note: body.note, stock, stockError: stockError ?? null });
      return { id, priceCents, stock, ...(stockError ? { stockError } : {}) };
    });
  }

  /** Undoes a comp, until its seller is paid for it (D7). Square's stock goes back to what's unsold. */
  async undo(orgId: string, swapId: string, compId: string, note: string, actorId: string) {
    const swap = await this.swapOrThrow(orgId, swapId);
    const comp = await this.prisma.swapComp.findFirst({ where: { id: compId, swapId } });
    if (!comp || !comp.liveKey) throw new NotFoundException('That comp was already undone.');
    if ((await this.paidComps([compId])).has(compId)) {
      throw new ConflictException('The seller was already paid for this comp. Settle it by hand on their payout card.');
    }
    await this.prisma.swapComp.update({ where: { id: compId }, data: { liveKey: null, undoneAt: new Date(), undoneBy: actorId, undoNote: note } });

    const item = await this.prisma.swapItem.findUnique({ where: { id: comp.itemId }, select: { sku: true, originalQuantity: true, squareVariationId: true, deletedAt: true, pickedUpAt: true } });
    let stock: number | null = null;
    let stockError: string | undefined;
    if (item?.squareVariationId && !item.deletedAt && !item.pickedUpAt && swap.locationId) {
      try {
        this.breakdown.forgetSales(swapId);
        const sold = (await this.breakdown.soldUnits(orgId, swapId)).get(item.squareVariationId) ?? 0;
        stock = Math.max(0, item.originalQuantity - sold);
        const pos = await this.pos.forOrg(orgId);
        if (!pos) throw new Error('Square isn’t connected.');
        await pos.setInventoryPhysicalCount(item.squareVariationId, swap.locationId, stock);
      } catch (err) {
        stockError = err instanceof Error ? err.message : 'Square’s stock couldn’t be set.';
        this.logger.warn({ err, compId }, 'Comp undone, but Square’s stock was not set');
      }
    }
    this.breakdown.forgetSales(swapId);
    await this.audit(orgId, actorId, 'ski_swap.comp.undone', { swapId, compId, itemId: comp.itemId, sku: item?.sku ?? null, note, stock, stockError: stockError ?? null });
    return { undone: true, stock, ...(stockError ? { stockError } : {}) };
  }

  /** Comps in a payout line whose money moved and wasn't returned (Plan 52 D6, D19). */
  private async paidComps(compIds: string[]): Promise<Set<string>> {
    if (!compIds.length) return new Set();
    const rows = await this.prisma.payoutLineItem.findMany({
      where: {
        squareOrderId: { in: compIds.map((id) => `${COMP_ORDER_PREFIX}${id}`) },
        line: { frozenAt: { not: null }, status: { notIn: [...NOT_PAID_STATUSES] } },
      },
      select: { squareOrderId: true },
    });
    return new Set(rows.map((r) => r.squareOrderId.slice(COMP_ORDER_PREFIX.length)));
  }

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, firstName: true, lastName: true, email: true } });
    return new Map(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Someone']));
  }

  private async once<T>(orgId: string, swapId: string, what: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    const scope = `comps:${what}:${orgId}:${swapId}`;
    if (key) {
      const cached = await this.idempotency.getCached(scope, key);
      if (cached) return cached as unknown as T;
    }
    const result = await fn();
    if (key) await this.idempotency.save(scope, key, result as unknown as Record<string, unknown>);
    return result;
  }

  private async swapOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({ where: { id: swapId, orgId }, select: { id: true, locationId: true } });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  private async audit(orgId: string, userId: string, action: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({ data: { actorType: 'user', actorId: userId, orgId, action, metadata: metadata as Prisma.InputJsonValue } });
  }
}
