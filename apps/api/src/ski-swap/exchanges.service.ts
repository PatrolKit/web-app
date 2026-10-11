import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type SwapExchange } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { PosAdapterFactory, type IPosAdapter, type PosSaleLine } from './pos/pos.adapter';
import { ItemBreakdownService } from './item-breakdown.service';
import { ItemService } from './item.service';
import { SELLER_NAME_INCLUDE, sellerDisplayName } from './seller.service';
import { attributeSales, lineKeyOf, netUnits, type DecisionRef, type ExchangeRef } from './sales-check';
import { receiptOf } from './sales-check.service';
import { squareSaleUrl } from './square-links';
import type {
  ExchangeItem, ExchangeLookupLine, ExchangeLookupResponse, ExchangesResponse, RecordExchangeResponse, SwapExchangeResponse,
} from '../contracts/exchanges.contracts';

/** One of the swap's items, as exchanges need it. */
interface Item extends ExchangeItem {
  squareVariationId: string | null;
  originalQuantity: number;
  returnedToSeller: boolean;
}

/** Everything a lookup or a change works from, read once. */
interface Read {
  orgId: string;
  swapId: string;
  locationId: string;
  pos: IPosAdapter;
  env: string;
  lines: PosSaleLine[];
  items: Item[];
  decisions: DecisionRef[];
  /** Live exchanges only. */
  exchanges: SwapExchange[];
}

/**
 * Exchanges (Plan 49): a customer handed back an item they bought and left
 * with another, recorded at the counter.
 *
 * Square's sale record is untouched (Square can't exchange without Square
 * Plus). The exchange is kept beside it, and every reader counts that sale
 * on the item that went out (`attributeSales`). Square's stock moves when
 * it's recorded, so the item that came back is for sale again and the one
 * that went out is sold. No money changes hands: the seller of the item that
 * went out is paid its listed price, and the patrol absorbs or keeps the
 * difference.
 */
@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pos: PosAdapterFactory,
    private readonly breakdown: ItemBreakdownService,
    private readonly idempotency: IdempotencyService,
    // Optional for the unit tests that build this by hand; Nest always supplies it.
    private readonly itemService?: ItemService,
  ) {}

  // ─── Reading ────────────────────────────────────────────────────────────────

  /** Every exchange, live or not, newest first. Reads no Square. */
  async list(orgId: string, swapId: string): Promise<ExchangesResponse> {
    await this.swapOrThrow(orgId, swapId);
    const [rows, config] = await Promise.all([
      this.prisma.swapExchange.findMany({ where: { swapId }, orderBy: { recordedAt: 'desc' } }),
      this.prisma.squareConfig.findUnique({ where: { orgId }, select: { environment: true } }),
    ]);
    const ids = [...new Set(rows.flatMap((r) => [r.returnedItemId, r.replacementItemId]))];
    const items = new Map((await this.itemsOf(swapId, ids)).map((i) => [i.id, i]));
    const names = await this.userNames(rows.flatMap((r) => [r.recordedBy, r.cancelledBy]));
    const supersededBy = new Map(rows.filter((r) => r.supersedesId).map((r) => [r.supersedesId!, r.id]));
    const exchanges = rows.map((r) => this.toResponse(r, items, names, supersededBy, config?.environment ?? 'production'));
    const totals = { live: 0, absorbedCents: 0, keptCents: 0 };
    for (const e of exchanges) {
      if (e.status !== 'live') continue;
      totals.live++;
      if (e.differenceCents !== null && e.differenceCents > 0) totals.absorbedCents += e.differenceCents;
      if (e.differenceCents !== null && e.differenceCents < 0) totals.keptCents -= e.differenceCents;
    }
    return { exchanges, totals };
  }

  /**
   * D3: the sale lines a receipt number or the ticket coming back finds, each
   * with the item it counts for now (after Sales check and earlier exchanges).
   * Reads Square afresh: the sale may be minutes old.
   */
  async lookup(orgId: string, swapId: string, q: { receipt?: string; ticket?: string }): Promise<ExchangeLookupResponse> {
    const receipt = q.receipt?.trim().replace(/^#/, '') ?? '';
    const ticket = q.ticket?.trim() ?? '';
    if (!receipt && !ticket) throw new BadRequestException('Type a receipt number or the ticket coming back.');
    let read: Read;
    try {
      read = await this.read(orgId, swapId, true);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      return { lines: [], error: err instanceof Error ? err.message : 'Square couldn’t be read.' };
    }
    const byVariation = new Map(read.items.filter((i) => i.squareVariationId).map((i) => [i.squareVariationId!, i]));
    // Either or both: a four-digit number could be a receipt or a ticket.
    const wanted = new Set(ticket ? read.items.filter((i) => i.sku === ticket && i.squareVariationId).map((i) => i.squareVariationId!) : []);
    const found = this.attributed(read).filter((l) => {
      if (!l.lineUid || netUnits(l) === 0 || !byVariation.has(l.variationId)) return false;
      return wanted.has(l.variationId) || (!!receipt && receiptOf(l.paymentId)?.toLowerCase() === receipt.toLowerCase());
    });
    const live = new Map(read.exchanges.map((e) => [lineKeyOf(e.orderId, e.lineUid), e]));
    const skus = new Map(read.items.map((i) => [i.id, i.sku]));
    const paid = await this.paidInRuns(found.map((l) => ({ orderId: l.orderId, itemId: byVariation.get(l.variationId)!.id })));
    const lines: ExchangeLookupLine[] = found
      .sort((a, b) => b.soldAt.getTime() - a.soldAt.getTime())
      .map((l) => {
        const item = byVariation.get(l.variationId)!;
        const ex = live.get(lineKeyOf(l.orderId, l.lineUid!));
        return {
          orderId: l.orderId, lineUid: l.lineUid!, receipt: receiptOf(l.paymentId), soldAt: l.soldAt.toISOString(),
          collectedCents: l.collectedCents, item: publicItem(item),
          exchange: ex ? { id: ex.id, returnedSku: skus.get(ex.returnedItemId) ?? '' } : null,
          paidInRun: paid.get(`${l.orderId}\u0000${item.id}`) ?? null,
          links: { sale: squareSaleUrl(read.env, l.orderId, l.paymentId ?? null) },
        };
      });
    return { lines, error: null };
  }

  // ─── Changes (ski_swap:admin; each re-checked and audited) ──────────────────

  /**
   * Records one (D9: re-checked against a fresh read of Square). Prices an
   * unpriced item going out (D7), saves, then moves Square's stock (D5). A
   * stock move that fails leaves the exchange saved and flagged for Retry.
   */
  async record(
    orgId: string, swapId: string,
    body: { orderId: string; lineUid: string; returnedItemId: string; replacementItemId: string; priceCents?: number; note?: string },
    userId: string, key?: string,
  ): Promise<RecordExchangeResponse> {
    return this.once(orgId, swapId, 'record', key, async () => {
      const read = await this.read(orgId, swapId, true);
      const lineKey = lineKeyOf(body.orderId, body.lineUid);
      const raw = read.lines.find((l) => l.orderId === body.orderId && l.lineUid === body.lineUid);
      if (!raw) throw new NotFoundException('Square doesn’t have that sale. Look it up again.');
      const line = this.attributed(read).find((l) => l.orderId === body.orderId && l.lineUid === body.lineUid)!;
      const returned = read.items.find((i) => i.id === body.returnedItemId);
      if (!returned) throw new NotFoundException('The item coming back isn’t in this swap.');
      if (!returned.squareVariationId || line.variationId !== returned.squareVariationId) {
        throw new ConflictException(`That sale isn’t counted on ${returned.sku} any more: look it up again.`);
      }
      if (netUnits(line) === 0) throw new ConflictException('That sale was refunded in Square, so there’s nothing to exchange.');

      const out = read.items.find((i) => i.id === body.replacementItemId);
      if (!out || out.deleted) throw new NotFoundException('The item going out isn’t in this swap.');
      if (out.id === returned.id) throw new BadRequestException('The item going out is the one coming back.');
      if (out.returnedToSeller) throw new ConflictException(`${out.sku} was handed back to its seller: pick an item that’s for sale.`);
      if (!out.squareVariationId) throw new ConflictException(`${out.sku} isn’t in Square yet: pick an item that’s for sale.`);
      if (this.soldUnits(read, out.squareVariationId) >= out.originalQuantity) {
        throw new ConflictException(`${out.sku} is sold already: pick an item that’s for sale.`);
      }
      const stock = (await read.pos.getInventoryCounts([out.squareVariationId], read.locationId)).get(out.squareVariationId) ?? 0;
      if (stock <= 0) throw new ConflictException(`Square has ${out.sku} out of stock: pick an item that’s for sale.`);

      // D7: an unpriced item going out takes a price first, since its seller is paid it.
      let replacementPriceCents = out.priceCents;
      let pricedCents: number | null = null;
      if (body.priceCents !== undefined) {
        if (out.priceCents !== null) throw new ConflictException(`${out.sku} already has a price (${money(out.priceCents)}).`);
        if (!this.itemService) throw new BadRequestException('Prices can’t be set here.');
        await this.itemService.patch(orgId, swapId, out.id, { priceCents: body.priceCents, ifUnpriced: true, actorId: userId });
        replacementPriceCents = pricedCents = body.priceCents;
      } else if (out.priceCents === null) {
        throw new BadRequestException(`${out.sku} has no price yet. Give it one: its seller is paid it.`);
      }

      const previous = read.exchanges.find((e) => lineKeyOf(e.orderId, e.lineUid) === lineKey) ?? null;
      let saved: SwapExchange;
      try {
        saved = await this.prisma.$transaction(async (tx) => {
          // D10: a second exchange of the same sale supersedes the first.
          if (previous) {
            const freed = await tx.swapExchange.updateMany({ where: { id: previous.id, liveKey: lineKey }, data: { liveKey: null } });
            if (freed.count !== 1) throw new ConflictException('That sale was exchanged again just now. Look it up again.');
          }
          return tx.swapExchange.create({
            data: {
              swapId, orgId, orderId: body.orderId, lineUid: body.lineUid, paymentId: raw.paymentId ?? null,
              returnedItemId: returned.id, replacementItemId: out.id,
              returnedPriceCents: returned.priceCents, replacementPriceCents,
              note: body.note?.trim() || null, stockSynced: false, supersedesId: previous?.id ?? null,
              recordedBy: userId, liveKey: lineKey,
            },
          });
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new ConflictException('That sale was exchanged just now. Look it up again.');
        }
        throw err;
      }
      this.breakdown.forgetSales(swapId);

      // D5: stock after the save. The books are right either way.
      let stockError: string | null = null;
      try {
        await this.moveStock(read, returned.squareVariationId, +1);
        await this.moveStock(read, out.squareVariationId, -1);
        saved = await this.prisma.swapExchange.update({ where: { id: saved.id }, data: { stockSynced: true } });
      } catch (err) {
        stockError = err instanceof Error ? err.message : 'Square’s stock couldn’t be updated.';
        this.logger.warn({ err, exchangeId: saved.id }, 'Exchange saved, but Square’s stock was not updated');
      }

      await this.audit(orgId, userId, 'ski_swap.exchange.recorded', {
        swapId, exchangeId: saved.id, orderId: body.orderId, lineUid: body.lineUid,
        returnedItemId: returned.id, returnedSku: returned.sku, replacementItemId: out.id, replacementSku: out.sku,
        returnedPriceCents: returned.priceCents, replacementPriceCents, pricedCents,
        supersedesId: previous?.id ?? null, stockSynced: saved.stockSynced,
      });
      return { exchange: await this.one(orgId, swapId, saved.id), stockError, pricedCents };
    });
  }

  /** Edits the note. Anything else is changed by cancelling and recording again. */
  async editNote(orgId: string, swapId: string, id: string, note: string, userId: string): Promise<SwapExchangeResponse> {
    await this.swapOrThrow(orgId, swapId);
    const row = await this.prisma.swapExchange.findFirst({ where: { id, swapId } });
    if (!row) throw new NotFoundException('Exchange not found.');
    const text = note.trim() || null;
    await this.prisma.swapExchange.update({ where: { id }, data: { note: text } });
    await this.audit(orgId, userId, 'ski_swap.exchange.note_edited', { swapId, exchangeId: id, before: row.note, after: text });
    return this.one(orgId, swapId, id);
  }

  /**
   * D11: cancels a live exchange, keeping the record, and reverses its stock
   * move. Refused when the item that came back has sold again since. The
   * exchange it superseded, if any, is live again (D10).
   */
  async cancel(orgId: string, swapId: string, id: string, reason: string, userId: string): Promise<SwapExchangeResponse> {
    const read = await this.read(orgId, swapId, true);
    const row = await this.prisma.swapExchange.findFirst({ where: { id, swapId } });
    if (!row) throw new NotFoundException('Exchange not found.');
    if (row.cancelledAt) throw new ConflictException('That exchange was already cancelled.');
    const liveKey = row.liveKey;
    if (!liveKey) throw new ConflictException('A later exchange replaced this one. Cancel that one first.');
    const returned = read.items.find((i) => i.id === row.returnedItemId);
    const out = read.items.find((i) => i.id === row.replacementItemId);
    if (returned?.squareVariationId && this.soldUnits(read, returned.squareVariationId) >= returned.originalQuantity) {
      throw new ConflictException(`${returned.sku} has sold again since the exchange, so cancelling would put two on the floor.`);
    }

    await this.prisma.$transaction(async (tx) => {
      const done = await tx.swapExchange.updateMany({
        where: { id, liveKey },
        data: { liveKey: null, cancelledAt: new Date(), cancelledBy: userId, cancelReason: reason.trim() },
      });
      if (done.count !== 1) throw new ConflictException('That exchange changed just now. Reload and try again.');
      if (row.supersedesId) await tx.swapExchange.update({ where: { id: row.supersedesId }, data: { liveKey } });
    });
    this.breakdown.forgetSales(swapId);

    // Reverse the stock move: by one each way when it landed; when it never
    // did, each item is set to what its sales leave, as Retry would.
    let stockReversed = true;
    try {
      if (row.stockSynced) {
        if (returned?.squareVariationId) await this.moveStock(read, returned.squareVariationId, -1);
        if (out?.squareVariationId) await this.moveStock(read, out.squareVariationId, +1);
      } else {
        const restored = row.supersedesId ? await this.prisma.swapExchange.findUnique({ where: { id: row.supersedesId } }) : null;
        const after = { ...read, exchanges: [...read.exchanges.filter((e) => e.id !== id), ...(restored ? [restored] : [])] };
        for (const it of [returned, out]) if (it?.squareVariationId) await this.settleStock(after, it);
      }
    } catch (err) {
      stockReversed = false;
      this.logger.warn({ err, exchangeId: id }, 'Exchange cancelled, but Square’s stock was not put back');
    }
    await this.audit(orgId, userId, 'ski_swap.exchange.cancelled', {
      swapId, exchangeId: id, reason: reason.trim(), returnedItemId: row.returnedItemId, replacementItemId: row.replacementItemId,
      restoredId: row.supersedesId, stockReversed,
    });
    if (!stockReversed) {
      throw new ConflictException('Cancelled, but Square’s stock couldn’t be put back. Run Catalog check to fix the stock.');
    }
    return this.one(orgId, swapId, id);
  }

  /** D5: Square's stock for a live exchange whose moves didn't land: each item set to what its sales leave. */
  async retryStock(orgId: string, swapId: string, id: string, userId: string): Promise<SwapExchangeResponse> {
    const read = await this.read(orgId, swapId, true);
    const row = read.exchanges.find((e) => e.id === id);
    if (!row) throw new ConflictException('Only a live exchange’s stock can be retried.');
    if (row.stockSynced) return this.one(orgId, swapId, id);
    for (const itemId of [row.returnedItemId, row.replacementItemId]) {
      const it = read.items.find((i) => i.id === itemId);
      if (it?.squareVariationId) await this.settleStock(read, it);
    }
    await this.prisma.swapExchange.update({ where: { id }, data: { stockSynced: true } });
    await this.audit(orgId, userId, 'ski_swap.exchange.stock_retried', { swapId, exchangeId: id });
    return this.one(orgId, swapId, id);
  }

  // ─── Inside ─────────────────────────────────────────────────────────────────

  private attributed(read: Read): PosSaleLine[] {
    const ours = new Set(read.items.map((i) => i.squareVariationId).filter((v): v is string => !!v));
    const variationOfItem = new Map(read.items.filter((i) => i.squareVariationId).map((i) => [i.id, i.squareVariationId!]));
    const refs: ExchangeRef[] = read.exchanges.map((e) => ({ orderId: e.orderId, lineUid: e.lineUid, replacementItemId: e.replacementItemId }));
    return attributeSales(read.lines, read.decisions, refs, ours, variationOfItem);
  }

  /** Units counted sold on a variation, after decisions and exchanges. */
  private soldUnits(read: Read, variationId: string): number {
    return this.attributed(read).filter((l) => l.variationId === variationId).reduce((n, l) => n + netUnits(l), 0);
  }

  /** Read Square's count, then set it one higher or lower; never below 0. */
  private async moveStock(read: Read, variationId: string, by: 1 | -1): Promise<void> {
    const now = (await read.pos.getInventoryCounts([variationId], read.locationId)).get(variationId) ?? 0;
    await read.pos.setInventoryPhysicalCount(variationId, read.locationId, Math.max(0, now + by));
  }

  /** An item's stock set to its units less what its sales count, as Sales check's restock does. */
  private async settleStock(read: Read, item: Item): Promise<void> {
    const stock = Math.max(0, item.originalQuantity - this.soldUnits(read, item.squareVariationId!));
    await read.pos.setInventoryPhysicalCount(item.squareVariationId!, read.locationId, stock);
  }

  private async read(orgId: string, swapId: string, fresh: boolean): Promise<Read> {
    const swap = await this.swapOrThrow(orgId, swapId);
    if (!swap.locationId) throw new BadRequestException('This swap has no Square location.');
    if (fresh) this.breakdown.forgetSales(swapId);
    const raw = await this.breakdown.rawSales(orgId, swapId);
    const pos = await this.pos.forOrg(orgId);
    if (!pos) throw new BadRequestException('Square isn’t connected.');
    const [items, decisions, exchanges, config] = await Promise.all([
      this.itemsOf(swapId),
      this.prisma.swapSaleDecision.findMany({ where: { swapId, liveKey: { not: null } }, select: { orderId: true, lineUid: true, decision: true, itemId: true } }),
      this.prisma.swapExchange.findMany({ where: { swapId, liveKey: { not: null } } }),
      this.prisma.squareConfig.findUnique({ where: { orgId }, select: { environment: true } }),
    ]);
    return {
      orgId, swapId, locationId: swap.locationId, pos, env: config?.environment ?? 'production',
      lines: raw.lines, items, decisions: decisions as DecisionRef[], exchanges,
    };
  }

  /** The swap's items, withdrawn ones too (a sale on one is still that item's). */
  private async itemsOf(swapId: string, ids?: string[]): Promise<Item[]> {
    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, ...(ids ? { id: { in: ids } } : {}) },
      select: {
        id: true, sku: true, name: true, priceCents: true, squareVariationId: true, originalQuantity: true,
        deletedAt: true, returnedAt: true, seller: { include: SELLER_NAME_INCLUDE },
      },
    });
    return rows.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, priceCents: r.priceCents, squareVariationId: r.squareVariationId,
      originalQuantity: r.originalQuantity, deleted: r.deletedAt !== null, returnedToSeller: r.returnedAt !== null,
      sellerId: r.seller?.id ?? null, sellerName: r.seller ? sellerDisplayName(r.seller) : null,
    }));
  }

  /** D12: payout runs past draft that already paid these items on these sales. */
  private async paidInRuns(sales: { orderId: string; itemId: string }[]): Promise<Map<string, { runId: string; status: string }>> {
    if (sales.length === 0) return new Map();
    const rows = await this.prisma.payoutLineItem.findMany({
      where: {
        itemId: { in: [...new Set(sales.map((s) => s.itemId))] },
        squareOrderId: { in: [...new Set(sales.map((s) => s.orderId))] },
        line: { run: { status: { not: 'DRAFT' } } },
      },
      select: { itemId: true, squareOrderId: true, line: { select: { run: { select: { id: true, status: true } } } } },
    });
    return new Map(rows.map((r) => [`${r.squareOrderId}\u0000${r.itemId}`, { runId: r.line.run.id, status: r.line.run.status }]));
  }

  private async one(orgId: string, swapId: string, id: string): Promise<SwapExchangeResponse> {
    const found = (await this.list(orgId, swapId)).exchanges.find((e) => e.id === id);
    if (!found) throw new NotFoundException('Exchange not found.');
    return found;
  }

  private toResponse(
    r: SwapExchange, items: Map<string, Item>, names: Map<string, string>, supersededBy: Map<string, string>, env: string,
  ): SwapExchangeResponse {
    const missing = (id: string): ExchangeItem => ({ id, sku: '?', name: 'An item no longer in this swap', priceCents: null, sellerId: null, sellerName: null, deleted: true });
    const returned = items.get(r.returnedItemId);
    const replacement = items.get(r.replacementItemId);
    return {
      id: r.id,
      status: r.liveKey ? 'live' : r.cancelledAt ? 'cancelled' : 'superseded',
      orderId: r.orderId, lineUid: r.lineUid, receipt: receiptOf(r.paymentId),
      returned: returned ? publicItem(returned) : missing(r.returnedItemId),
      replacement: replacement ? publicItem(replacement) : missing(r.replacementItemId),
      returnedPriceCents: r.returnedPriceCents, replacementPriceCents: r.replacementPriceCents,
      differenceCents: r.returnedPriceCents !== null && r.replacementPriceCents !== null ? r.replacementPriceCents - r.returnedPriceCents : null,
      note: r.note, stockSynced: r.stockSynced,
      supersedesId: r.supersedesId, supersededById: supersededBy.get(r.id) ?? null,
      recordedByName: r.recordedBy ? names.get(r.recordedBy) ?? null : null, recordedAt: r.recordedAt.toISOString(),
      cancelledByName: r.cancelledBy ? names.get(r.cancelledBy) ?? null : null, cancelledAt: r.cancelledAt?.toISOString() ?? null,
      cancelReason: r.cancelReason,
      links: { sale: squareSaleUrl(env, r.orderId, r.paymentId) },
    };
  }

  /** A change made once per `Idempotency-Key`: a retry answers as the first did. */
  private async once<T>(orgId: string, swapId: string, what: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    const scope = `exchanges:${what}:${orgId}:${swapId}`;
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

  private async userNames(ids: (string | null)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (want.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, firstName: true, lastName: true, email: true } });
    return new Map(users.map((u) => [u.id, [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Someone']));
  }

  private async audit(orgId: string, userId: string, action: string, metadata: Record<string, unknown>) {
    await this.prisma.auditLog.create({
      data: { actorType: 'user', actorId: userId, orgId, action, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}

function publicItem(i: Item): ExchangeItem {
  return { id: i.id, sku: i.sku, name: i.name, priceCents: i.priceCents, sellerId: i.sellerId, sellerName: i.sellerName, deleted: i.deleted };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
