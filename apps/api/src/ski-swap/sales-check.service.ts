import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { PosAdapterFactory, type IPosAdapter, type PosSaleLine } from './pos/pos.adapter';
import { ItemBreakdownService } from './item-breakdown.service';
import { IssuedTicketService } from './issued-ticket.service';
import { ItemService } from './item.service';
import { SELLER_NAME_INCLUDE, sellerDisplayName } from './seller.service';
import { applyDecisions, classify, lineKeyOf, netUnits, salesHolds, type CheckItem, type DecisionRef, type SalesHolds } from './sales-check';
import { squareItemUrl, squareSaleUrl } from './square-links';
import { FEE_LINE, feeCheck, feeKeyOf } from './fee-check';
import type {
  SalesCheckCount, SalesCheckDecided, SalesCheckIssue, SalesCheckOutcome, SalesCheckResponse,
} from '../contracts/sales-check.contracts';

type Line = { orderId: string; lineUid: string };

/**
 * Sales check (Plan 48): Square's sale lines that aren't on this swap's items,
 * and the decisions staff make about them.
 *
 * `list` and `count` only read (D13): Square's sales (the dashboard's cached
 * read), what those lines were rung up on, and our own rows. Everything else
 * here is a person's choice, re-checked against Square before it's applied,
 * and audited.
 */
@Injectable()
export class SalesCheckService {
  private readonly logger = new Logger(SalesCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pos: PosAdapterFactory,
    private readonly breakdown: ItemBreakdownService,
    private readonly issued: IssuedTicketService,
    private readonly idempotency: IdempotencyService,
    // Optional for the unit tests that build this by hand; Nest always supplies it.
    private readonly items?: ItemService,
  ) {}

  // ─── Reading (D13: no writes) ──────────────────────────────────────────────

  async list(orgId: string, swapId: string): Promise<SalesCheckResponse> {
    const read = await this.read(orgId, swapId);
    if ('error' in read) return { asOf: new Date().toISOString(), error: read.error ?? 'Square couldn’t be read.', issues: [], decided: [], ignoredCategories: [], missedFees: null };
    const { swap, at, lines, fees, items, decisions, pos, env } = read;

    const ourVariations = new Set(items.map((i) => i.squareVariationId).filter((v): v is string => !!v));
    const unknown = lines.filter((l) => l.variationId && !ourVariations.has(l.variationId)).map((l) => l.variationId);
    const [described, categoryNames] = await Promise.all([pos.describeVariations(unknown), pos.listCategories()]);
    const ignored = new Set(ignoredOf(swap.ignoredSquareCategoryIds));

    const found = classify({
      lines, items, described, categoryNames, ignoredCategoryIds: ignored,
      decisions: decisions.map(toRef),
    });
    const paymentOf = new Map(lines.map((l) => [lineKeyOf(l.orderId, l.lineUid ?? ''), l.paymentId ?? null]));
    const issues: SalesCheckIssue[] = found.map((i) => ({
      key: i.key, kind: i.kind, orderId: i.orderId, lineUid: i.lineUid, soldAt: i.soldAt,
      quantity: i.quantity, refundedQuantity: i.refundedQuantity, collectedCents: i.collectedCents, unitPriceCents: i.unitPriceCents,
      rungUpAs: i.rungUpAs, suggestion: i.suggestion, ticket: i.ticket, ...(i.oversold ? { oversold: i.oversold } : {}),
      categoryIds: i.rungUpAs ? described.get(i.rungUpAs.variationId)?.categoryIds ?? [] : [],
      links: { sale: squareSaleUrl(env, i.orderId, i.paymentId), item: squareItemUrl(env, i.rungUpAs?.itemId ?? null) },
    }));

    // The fee check: a sale charged both fees, or a Shop Fee on cash. One per
    // order, keyed `order:#fee`; cleared by Square showing the fee refunded.
    const handled = new Set(decisions.filter((d) => d.decision === 'FEE_HANDLED').map((d) => feeKeyOf(d.orderId)));
    const fee = fees ? feeCheck(fees, handled) : null;
    for (const f of fee?.issues ?? []) {
      issues.push({
        key: f.key, kind: f.kind, orderId: f.orderId, lineUid: FEE_LINE, soldAt: f.soldAt.toISOString(),
        quantity: 1, refundedQuantity: 0, collectedCents: f.refundCents, unitPriceCents: null,
        rungUpAs: null, suggestion: null, ticket: null, categoryIds: [],
        links: { sale: squareSaleUrl(env, f.orderId, f.paymentId), item: null },
        fee: { shopFeeName: f.shopFeeName, shopFeeCents: f.shopFeeCents, surchargeCents: f.surchargeCents, cardCents: f.cardCents, cashCents: f.cashCents, refundCents: f.refundCents },
      });
    }

    const byId = new Map(items.map((i) => [i.id, i]));
    const names = await this.userNames(decisions.map((d) => d.decidedBy));
    const decided: SalesCheckDecided[] = decisions.map((d) => {
      const item = d.itemId ? byId.get(d.itemId) : undefined;
      return {
        id: d.id, key: lineKeyOf(d.orderId, d.lineUid), decision: d.decision as SalesCheckDecided['decision'],
        orderId: d.orderId, lineUid: d.lineUid, collectedCents: d.collectedCents,
        item: item ? { id: item.id, sku: item.sku, name: item.name } : null,
        note: d.note, markedSold: d.markedSold, decidedBy: d.decidedBy ? names.get(d.decidedBy) ?? null : null,
        decidedAt: d.decidedAt.toISOString(),
        links: { sale: squareSaleUrl(env, d.orderId, paymentOf.get(lineKeyOf(d.orderId, d.lineUid)) ?? null) },
      };
    });

    return {
      asOf: new Date(at).toISOString(), error: null, issues, decided,
      ignoredCategories: [...ignored].map((id) => ({ id, name: categoryNames.get(id) ?? id })),
      missedFees: fee?.missed ?? null,
    };
  }

  /** What open sales hold back in Catalog check (D13: no writes). */
  async holds(orgId: string, swapId: string): Promise<SalesHolds | { error: string }> {
    const res = await this.list(orgId, swapId);
    return res.error ? { error: res.error } : salesHolds(res.issues);
  }

  /** The dashboard card (D13: no writes): how many lines need a decision. */
  async count(orgId: string, swapId: string): Promise<SalesCheckCount> {
    const res = await this.list(orgId, swapId);
    return { open: res.issues.length, error: res.error };
  }

  // ─── Choices (D13: a person's, re-checked, audited) ─────────────────────────

  /**
   * One sale to one item. With `priceCents`, an unpriced item takes that
   * price too, through the item edit (so Square's item has it), once the
   * sale is credited. An item with a price keeps it: the price is refused
   * up front, and nothing is credited.
   */
  async credit(orgId: string, swapId: string, body: Line & { itemId: string; markSold: boolean; priceCents?: number }, userId: string, key?: string): Promise<SalesCheckOutcome> {
    return this.once(orgId, swapId, 'credit', key, async () => {
      const ctx = await this.context(orgId, swapId);
      if (body.priceCents !== undefined) {
        const item = ctx.items.find((i) => i.id === body.itemId && !i.deleted);
        if (item && item.priceCents !== null) {
          throw new ConflictException(`${item.sku} already has a price ($${(item.priceCents / 100).toFixed(2)}). Accept the suggestion without one.`);
        }
      }
      const outcome = await this.creditOne(ctx, body, body.markSold, userId);
      if (!outcome.ok) throw new ConflictException(outcome.error);
      if (body.priceCents === undefined) return outcome;
      if (!this.items) return { ...outcome, priceError: 'Prices can’t be set here.' };
      try {
        await this.items.patch(orgId, swapId, body.itemId, { priceCents: body.priceCents, ifUnpriced: true, actorId: userId });
        await this.audit(orgId, userId, 'ski_swap.sales_check.priced', { swapId, itemId: body.itemId, priceCents: body.priceCents, orderId: body.orderId, lineUid: body.lineUid });
        return { ...outcome, pricedCents: body.priceCents };
      } catch (err) {
        const message = err instanceof ConflictException ? String((err.getResponse() as { message?: string }).message ?? err.message) : err instanceof Error ? err.message : 'The price couldn’t be set.';
        this.logger.warn({ err, itemId: body.itemId }, 'Sales check: credited, but the price was not set');
        return { ...outcome, priceError: message };
      }
    });
  }

  /** D13: exactly these lines, each re-checked; reports per line. */
  async creditMany(orgId: string, swapId: string, body: { lines: (Line & { itemId: string })[]; markSold: boolean }, userId: string, key?: string): Promise<{ outcomes: SalesCheckOutcome[] }> {
    return this.once(orgId, swapId, 'credit-many', key, async () => {
      const ctx = await this.context(orgId, swapId);
      const outcomes: SalesCheckOutcome[] = [];
      for (const l of body.lines) outcomes.push(await this.creditOne(ctx, l, body.markSold, userId));
      return { outcomes };
    });
  }

  async notSwapSale(orgId: string, swapId: string, body: Line & { note?: string }, userId: string, key?: string): Promise<SalesCheckOutcome> {
    return this.once(orgId, swapId, 'not-swap', key, async () => {
      const ctx = await this.context(orgId, swapId);
      const line = await ctx.pos.getSaleLine(body.orderId, body.lineUid);
      if (!line) throw new NotFoundException('Square no longer has that sale.');
      if (line.variationId && ctx.ourVariations.has(line.variationId)) throw new ConflictException('That sale is on one of this swap’s items.');
      await this.decide(ctx, line, { decision: 'NOT_SWAP', note: body.note?.trim() || null }, userId);
      await this.audit(ctx.orgId, userId, 'ski_swap.sales_check.not_swap_sale', { swapId, orderId: body.orderId, lineUid: body.lineUid, collectedCents: line.collectedCents, note: body.note ?? null });
      this.breakdown.forgetSales(swapId);
      return { key: lineKeyOf(body.orderId, body.lineUid), ok: true };
    });
  }

  /** Re-opens a line. Never touches Square stock: `markedSold` says whether to offer putting it back. */
  async undo(orgId: string, swapId: string, decisionId: string, userId: string): Promise<{ markedSold: boolean; itemId: string | null }> {
    await this.swapOrThrow(orgId, swapId);
    const d = await this.prisma.swapSaleDecision.findFirst({ where: { id: decisionId, swapId, liveKey: { not: null } } });
    if (!d) throw new NotFoundException('That decision was already undone.');
    await this.prisma.swapSaleDecision.update({ where: { id: d.id }, data: { liveKey: null, undoneAt: new Date(), undoneBy: userId } });
    await this.audit(orgId, userId, 'ski_swap.sales_check.undone', { swapId, decisionId, decision: d.decision, orderId: d.orderId, lineUid: d.lineUid, itemId: d.itemId });
    this.breakdown.forgetSales(swapId);
    return { markedSold: d.markedSold, itemId: d.itemId };
  }

  /**
   * After an undo, puts a credited item back in stock: its units less what
   * its own sales still account for. Only on request; never by itself.
   */
  async restock(orgId: string, swapId: string, itemId: string, userId: string): Promise<{ stock: number }> {
    const ctx = await this.context(orgId, swapId);
    const item = ctx.items.find((i) => i.id === itemId && !i.deleted);
    if (!item?.squareVariationId) throw new NotFoundException('That item isn’t in Square.');
    const attributed = applyDecisions(ctx.lines, ctx.decisions.map(toRef), ctx.ourVariations, ctx.variationOfItem)
      .filter((l) => l.variationId === item.squareVariationId)
      .reduce((n, l) => n + netUnits(l), 0);
    const stock = Math.max(0, item.originalQuantity - attributed);
    await ctx.pos.setInventoryPhysicalCount(item.squareVariationId, ctx.locationId, stock);
    await this.audit(orgId, userId, 'ski_swap.sales_check.restocked', { swapId, itemId, stock });
    this.breakdown.forgetSales(swapId);
    return { stock };
  }

  /**
   * A fee check refunded some way Square doesn't show (an amount refund, say):
   * marked handled, so it leaves the list. Undone like any decision.
   */
  async feeHandled(orgId: string, swapId: string, body: { orderId: string }, userId: string, key?: string): Promise<SalesCheckOutcome> {
    return this.once(orgId, swapId, 'fee-handled', key, async () => {
      const read = await this.read(orgId, swapId);
      if ('error' in read) throw new BadRequestException(read.error);
      const handled = new Set(read.decisions.filter((d) => d.decision === 'FEE_HANDLED').map((d) => feeKeyOf(d.orderId)));
      const issue = read.fees ? feeCheck(read.fees, handled).issues.find((f) => f.orderId === body.orderId) : undefined;
      const feeKey = feeKeyOf(body.orderId);
      if (!issue) return { key: feeKey, ok: false, error: 'That fee isn’t waiting any more: it’s been refunded, or already marked.' };
      try {
        await this.prisma.swapSaleDecision.create({
          data: {
            swapId, orgId, orderId: body.orderId, lineUid: FEE_LINE, decision: 'FEE_HANDLED', itemId: null,
            collectedCents: issue.refundCents, variationId: null, note: null, decidedBy: userId, liveKey: feeKey,
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { key: feeKey, ok: false, error: 'That fee was already marked.' };
        throw err;
      }
      await this.audit(orgId, userId, 'ski_swap.sales_check.fee_handled', { swapId, orderId: body.orderId, kind: issue.kind, refundCents: issue.refundCents });
      return { key: feeKey, ok: true };
    });
  }

  /** D7: a whole Square category is never (or again) this swap's sales. */
  async ignoreCategory(orgId: string, swapId: string, body: { categoryId: string; ignore: boolean }, userId: string): Promise<{ ignored: string[] }> {
    const swap = await this.swapOrThrow(orgId, swapId);
    const list = new Set(ignoredOf(swap.ignoredSquareCategoryIds));
    if (body.ignore) list.add(body.categoryId);
    else list.delete(body.categoryId);
    const ignored = [...list];
    await this.prisma.skiSwap.update({ where: { id: swap.id }, data: { ignoredSquareCategoryIds: ignored as Prisma.InputJsonValue } });
    await this.audit(orgId, userId, 'ski_swap.sales_check.category_ignored', { swapId, categoryId: body.categoryId, ignore: body.ignore });
    return { ignored };
  }

  /**
   * D9: a ticket no item has. Issued to the seller, put in Square (awaited),
   * then the sale is credited to it. A push that fails credits nothing; the
   * ticket stays issued for a retry.
   */
  async issueAndCredit(orgId: string, swapId: string, body: Line & { sellerId: string; ticket: string }, userId: string, key?: string): Promise<SalesCheckOutcome> {
    return this.once(orgId, swapId, 'issue-and-credit', key, async () => {
      const ctx = await this.context(orgId, swapId);
      const line = await ctx.pos.getSaleLine(body.orderId, body.lineUid);
      if (!line) throw new NotFoundException('Square no longer has that sale.');
      await this.issued.batchAdd(orgId, swapId, body.sellerId, [body.ticket], userId);
      const created = await this.prisma.swapItem.findFirst({ where: { swapId, sku: body.ticket, deletedAt: null }, select: { id: true } });
      if (!created) throw new ConflictException('The ticket wasn’t issued.');
      await this.issued.push(orgId, swapId, [created.id]);
      const fresh = await this.context(orgId, swapId);
      const item = fresh.items.find((i) => i.id === created.id);
      if (!item?.squareVariationId) {
        throw new ConflictException(`Ticket ${body.ticket} is issued, but couldn’t be put in Square yet. Pick it for this sale again in a minute.`);
      }
      const outcome = await this.creditOne(fresh, { ...body, itemId: created.id }, true, userId);
      if (!outcome.ok) throw new ConflictException(outcome.error);
      await this.audit(orgId, userId, 'ski_swap.sales_check.issued_and_credited', { swapId, ticket: body.ticket, sellerId: body.sellerId, itemId: created.id, orderId: body.orderId, lineUid: body.lineUid });
      return outcome;
    });
  }

  // ─── Inside ─────────────────────────────────────────────────────────────────

  private async creditOne(ctx: Ctx, l: Line & { itemId: string }, markSold: boolean, userId: string): Promise<SalesCheckOutcome> {
    const key = lineKeyOf(l.orderId, l.lineUid);
    try {
      const item = ctx.items.find((i) => i.id === l.itemId && !i.deleted);
      if (!item) return { key, ok: false, error: 'That item isn’t in this swap.' };
      if (!item.squareVariationId) return { key, ok: false, error: 'That item isn’t in Square yet, so the sale can’t count as its.' };
      const line = await ctx.pos.getSaleLine(l.orderId, l.lineUid);
      if (!line) return { key, ok: false, error: 'Square no longer has that sale.' };
      if (line.variationId && ctx.ourVariations.has(line.variationId)) return { key, ok: false, error: 'That sale is already on one of this swap’s items.' };
      if (ctx.decisions.some((d) => lineKeyOf(d.orderId, d.lineUid) === key)) return { key, ok: false, error: 'That sale was already decided.' };
      const units = netUnits(line);
      // The oversold guard: never count an item sold more times than it has units.
      const already = applyDecisions(ctx.lines, ctx.decisions.map(toRef), ctx.ourVariations, ctx.variationOfItem)
        .filter((x) => x.variationId === item.squareVariationId)
        .reduce((n, x) => n + netUnits(x), 0);
      if (already + units > item.originalQuantity) {
        return { key, ok: false, error: `${item.name} is already counted as sold. Undo the other sale first, or pick another item.` };
      }
      const decision = await this.decide(ctx, line, { decision: 'CREDIT', itemId: item.id, note: null }, userId);
      ctx.decisions.push(decision);

      let markedSold = false;
      if (markSold && units > 0) {
        // D6: only while Square still has more in stock than has sold.
        const counts = await ctx.pos.getInventoryCounts([item.squareVariationId], ctx.locationId);
        const stock = counts.get(item.squareVariationId) ?? 0;
        if (stock > 0) {
          await ctx.pos.setInventoryPhysicalCount(item.squareVariationId, ctx.locationId, Math.max(0, stock - units));
          await this.prisma.swapSaleDecision.update({ where: { id: decision.id }, data: { markedSold: true } });
          markedSold = true;
        }
      }
      await this.audit(ctx.orgId, userId, 'ski_swap.sales_check.credited', {
        swapId: ctx.swapId, orderId: l.orderId, lineUid: l.lineUid, itemId: item.id, sku: item.sku,
        collectedCents: line.collectedCents, variationId: line.variationId || null, markedSold,
      });
      this.breakdown.forgetSales(ctx.swapId);
      return { key, ok: true, markedSold };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { key, ok: false, error: 'That sale was already decided.' };
      this.logger.warn({ err, key }, 'Sales check credit failed');
      return { key, ok: false, error: err instanceof Error ? err.message : 'Couldn’t put that sale on the item.' };
    }
  }

  private async decide(ctx: Ctx, line: PosSaleLine, what: { decision: 'CREDIT' | 'NOT_SWAP'; itemId?: string; note: string | null }, userId: string) {
    const lineUid = line.lineUid!;
    try {
      return await this.prisma.swapSaleDecision.create({
        data: {
          swapId: ctx.swapId, orgId: ctx.orgId, orderId: line.orderId, lineUid,
          decision: what.decision, itemId: what.itemId ?? null, collectedCents: line.collectedCents,
          variationId: line.variationId || null, note: what.note, decidedBy: userId, liveKey: lineKeyOf(line.orderId, lineUid),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw new ConflictException('That sale was already decided.');
      throw err;
    }
  }

  /** Everything a list or a choice works from, read once. */
  private async read(orgId: string, swapId: string) {
    let raw: Awaited<ReturnType<ItemBreakdownService['rawSales']>>;
    try {
      raw = await this.breakdown.rawSales(orgId, swapId);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      return { error: err instanceof Error ? err.message : 'Square couldn’t be read.' };
    }
    const pos = await this.pos.forOrg(orgId);
    if (!pos) return { error: 'Square isn’t connected.' };
    const swap = await this.swapOrThrow(orgId, swapId);
    const [rows, decisions, config] = await Promise.all([
      this.prisma.swapItem.findMany({
        // Withdrawn ones too, marked: a sale on an item since withdrawn is still that item's.
        where: { swapId },
        select: {
          id: true, sku: true, name: true, priceCents: true, squareVariationId: true, originalQuantity: true, deletedAt: true,
          seller: { include: SELLER_NAME_INCLUDE },
        },
      }),
      this.prisma.swapSaleDecision.findMany({ where: { swapId, liveKey: { not: null } }, orderBy: { decidedAt: 'desc' } }),
      this.prisma.squareConfig.findUnique({ where: { orgId }, select: { environment: true } }),
    ]);
    const items: CheckItem[] = rows.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, priceCents: r.priceCents, squareVariationId: r.squareVariationId,
      originalQuantity: r.originalQuantity, deleted: r.deletedAt !== null, sellerName: r.seller ? sellerDisplayName(r.seller) : null, sellerId: r.seller?.id ?? null,
    }));
    return { swap, at: raw.at, lines: raw.lines, fees: raw.fees ?? null, items, decisions, pos, env: config?.environment ?? 'production' };
  }

  private async context(orgId: string, swapId: string): Promise<Ctx> {
    const read = await this.read(orgId, swapId);
    if ('error' in read) throw new BadRequestException(read.error);
    if (!read.swap.locationId) throw new BadRequestException('This swap has no Square location.');
    return {
      orgId, swapId, locationId: read.swap.locationId, pos: read.pos, lines: read.lines, items: read.items, decisions: read.decisions,
      ourVariations: new Set(read.items.map((i) => i.squareVariationId).filter((v): v is string => !!v)),
      variationOfItem: new Map(read.items.filter((i) => i.squareVariationId).map((i) => [i.id, i.squareVariationId!])),
    };
  }

  /** A choice made once per `Idempotency-Key`: a retry answers as the first did. */
  private async once<T>(orgId: string, swapId: string, what: string, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    const scope = `sales-check:${what}:${orgId}:${swapId}`;
    if (key) {
      const cached = await this.idempotency.getCached(scope, key);
      if (cached) return cached as unknown as T;
    }
    const result = await fn();
    if (key) await this.idempotency.save(scope, key, result as unknown as Record<string, unknown>);
    return result;
  }

  private async swapOrThrow(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, orgId },
      select: { id: true, orgId: true, locationId: true, ignoredSquareCategoryIds: true },
    });
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

interface Ctx {
  orgId: string;
  swapId: string;
  locationId: string;
  pos: IPosAdapter;
  lines: PosSaleLine[];
  items: CheckItem[];
  decisions: { id: string; orderId: string; lineUid: string; decision: string; itemId: string | null }[];
  ourVariations: Set<string>;
  variationOfItem: Map<string, string>;
}

function toRef(d: { orderId: string; lineUid: string; decision: string; itemId: string | null }): DecisionRef {
  return { orderId: d.orderId, lineUid: d.lineUid, decision: d.decision as DecisionRef['decision'], itemId: d.itemId };
}

function ignoredOf(json: Prisma.JsonValue | null): string[] {
  return Array.isArray(json) ? json.filter((x): x is string => typeof x === 'string') : [];
}
