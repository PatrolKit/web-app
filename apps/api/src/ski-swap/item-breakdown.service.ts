import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory, type PosSaleLine } from './pos/pos.adapter';
import { uncategorisedName } from './sku.util';
import { salesHeatmap, soldByCategory, type SalesHeatmapData } from './sales-heatmap';
import { checkoutTotals, sellerTotals } from './seller-checkout-totals';
import { applyDecisions, type DecisionRef } from './sales-check';
import type { CheckoutTotals, SellerTotals } from '../contracts/ski-swap.contracts';

/**
 * The dashboard's pie: every live item in exactly one slice.
 *
 * - **sold**: Square's completed sales at the swap's location, less refunds
 *   (the same read payouts make), cover all its units;
 * - **returned**: handed back to its seller, unsold (Plan 43);
 * - **noPrice**: no price yet, such as an issued ticket nobody has filled in;
 * - **noDescription**: priced, but never described (no category, so still
 *   named "Item #<sku>"), such as a business's ticket priced from its tag;
 * - **notOnSale**: not accepted yet (waiting for a staff scan), or missing
 *   from Square, so the register can't sell it;
 * - **forSale**: everything else: what the register can sell.
 *
 * Checked in that order, so a sold item is sold whatever else is true of it.
 */
export interface ItemBreakdown {
  sold: number;
  returned: number;
  forSale: number;
  noPrice: number;
  noDescription: number;
  notOnSale: number;
  total: number;
  /** When Square's sales were read. */
  asOf: string;
  /** Square couldn't be read; the counts are zero and shouldn't be shown. */
  error: string | null;
}

export interface BreakdownItem {
  sku: string;
  name: string;
  priceCents: number | null;
  categoryId: string | null;
  consigned: boolean;
  returned: boolean;
  squareItemId: string | null;
  squareVariationId: string | null;
  originalQuantity: number;
}

/** Net units sold per variation: sold, less what came back. */
export function soldByVariation(sales: PosSaleLine[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sales) out.set(s.variationId, (out.get(s.variationId) ?? 0) + s.quantity - s.refundedQuantity);
  return out;
}

export function breakdown(items: BreakdownItem[], sold: Map<string, number>): Omit<ItemBreakdown, 'asOf' | 'error'> {
  const out = { sold: 0, returned: 0, forSale: 0, noPrice: 0, noDescription: 0, notOnSale: 0, total: items.length };
  for (const i of items) {
    const units = i.squareVariationId ? sold.get(i.squareVariationId) ?? 0 : 0;
    if (units > 0 && units >= i.originalQuantity) out.sold++;
    else if (i.returned) out.returned++;
    else if (i.priceCents === null) out.noPrice++;
    else if (!i.categoryId && i.name === uncategorisedName(i.sku)) out.noDescription++;
    else if (!i.consigned || !i.squareItemId || !i.squareVariationId) out.notOnSale++;
    else out.forSale++;
  }
  return out;
}

interface SalesRead {
  at: number;
  lines: PosSaleLine[];
}

/** How long a read of Square's sales is reused: the dashboard polls, Square shouldn't be. */
const CACHE_MS = 2 * 60 * 1000;

@Injectable()
export class ItemBreakdownService {
  private readonly logger = new Logger(ItemBreakdownService.name);
  /**
   * Square's sale lines per swap (Plan 46 D1): the Items tile, Sales by hour
   * and sold by category all read from one fetch. The read in flight is shared
   * too, so three cards asking at once still make one call.
   */
  private readonly salesCache = new Map<string, { at: number; read: Promise<SalesRead> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly pos: PosAdapterFactory,
  ) {}

  async get(orgId: string, swapId: string): Promise<ItemBreakdown> {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, orgId },
      select: { id: true, createdAt: true, locationId: true },
    });
    if (!swap) throw new NotFoundException('Swap not found');

    let read: SalesRead;
    try {
      read = await this.sales(orgId, swap);
    } catch (err) {
      this.logger.warn({ err, orgId, swapId }, 'Could not read Square sales for the dashboard');
      return {
        sold: 0, returned: 0, forSale: 0, noPrice: 0, noDescription: 0, notOnSale: 0, total: 0, asOf: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Square couldn’t be read.',
      };
    }

    const rows = await this.prisma.swapItem.findMany({
      where: { swapId, orgId, deletedAt: null },
      select: {
        sku: true, name: true, priceCents: true, categoryId: true, consignedAt: true, returnedAt: true,
        squareItemId: true, squareVariationId: true, originalQuantity: true,
      },
    });
    const items = rows.map((r) => ({ ...r, consigned: r.consignedAt !== null, returned: r.returnedAt !== null }));
    return { ...breakdown(items, soldByVariation(read.lines)), asOf: new Date(read.at).toISOString(), error: null };
  }

  /** Sales by hour (Plan 46 D4), in the swap's time zone. */
  async salesHeatmap(orgId: string, swapId: string): Promise<SalesHeatmapData & { timeZone: string; asOf: string; error: string | null }> {
    const swap = await this.swapOf(orgId, swapId);
    const empty = { days: [], hours: [], cells: [], totals: { units: 0, cents: 0 }, timeZone: swap.timeZone };
    let read: SalesRead;
    try {
      read = await this.sales(orgId, swap);
    } catch (err) {
      this.logger.warn({ err, orgId, swapId }, 'Could not read Square sales for the dashboard');
      return { ...empty, asOf: new Date().toISOString(), error: err instanceof Error ? err.message : 'Square couldn’t be read.' };
    }
    const items = await this.soldItems(swapId, orgId);
    const variations = new Set(items.map((i) => i.squareVariationId!));
    return { ...salesHeatmap(read.lines, variations, swap.timeZone), timeZone: swap.timeZone, asOf: new Date(read.at).toISOString(), error: null };
  }

  /** Units sold per category (Plan 46 D6): each sale to its item's current category. */
  async soldByCategory(orgId: string, swapId: string): Promise<{ categories: { categoryId: string | null; units: number }[]; asOf: string; error: string | null }> {
    const swap = await this.swapOf(orgId, swapId);
    let read: SalesRead;
    try {
      read = await this.sales(orgId, swap);
    } catch (err) {
      this.logger.warn({ err, orgId, swapId }, 'Could not read Square sales for the dashboard');
      return { categories: [], asOf: new Date().toISOString(), error: err instanceof Error ? err.message : 'Square couldn’t be read.' };
    }
    const items = await this.soldItems(swapId, orgId);
    const byVariation = new Map(items.map((i) => [i.squareVariationId!, i.categoryId]));
    const sold = soldByCategory(read.lines, byVariation);
    return {
      categories: [...sold].map(([categoryId, units]) => ({ categoryId, units })),
      asOf: new Date(read.at).toISOString(),
      error: null,
    };
  }

  /**
   * Each seller's items, listed and sold dollars, for the dashboard's seller
   * histogram. Our rows count without Square; sold waits on it.
   */
  async sellerTotals(orgId: string, swapId: string): Promise<SellerTotals> {
    const swap = await this.swapOf(orgId, swapId);
    let read: SalesRead | null = null;
    let error: string | null = null;
    try {
      read = await this.sales(orgId, swap);
    } catch (err) {
      this.logger.warn({ err, orgId, swapId }, 'Could not read Square sales for the dashboard');
      error = err instanceof Error ? err.message : 'Square couldn’t be read.';
    }
    const items = await this.prisma.swapItem.findMany({
      where: { swapId, orgId, sellerId: { not: null } },
      select: { sellerId: true, priceCents: true, squareVariationId: true, deletedAt: true, seller: { select: { businessName: true } } },
    });
    const rows = items.map((i) => ({
      sellerId: i.sellerId!,
      business: !!i.seller?.businessName,
      priceCents: i.priceCents,
      squareVariationId: i.squareVariationId,
      deleted: i.deletedAt !== null,
    }));
    return {
      sellers: sellerTotals(rows, read?.lines ?? null),
      asOf: new Date(read?.at ?? Date.now()).toISOString(),
      error,
    };
  }

  /** Each Square checkout of this swap's items, for the dashboard's buyer histogram. */
  async checkoutTotals(orgId: string, swapId: string): Promise<CheckoutTotals> {
    const swap = await this.swapOf(orgId, swapId);
    let read: SalesRead;
    try {
      read = await this.sales(orgId, swap);
    } catch (err) {
      this.logger.warn({ err, orgId, swapId }, 'Could not read Square sales for the dashboard');
      return { checkouts: [], asOf: new Date().toISOString(), error: err instanceof Error ? err.message : 'Square couldn’t be read.' };
    }
    const items = await this.soldItems(swapId, orgId);
    const variations = new Set(items.map((i) => i.squareVariationId!));
    return { checkouts: checkoutTotals(read.lines, variations), asOf: new Date(read.at).toISOString(), error: null };
  }

  private async swapOf(orgId: string, swapId: string) {
    const swap = await this.prisma.skiSwap.findFirst({
      where: { id: swapId, orgId },
      select: { id: true, createdAt: true, locationId: true, timeZone: true },
    });
    if (!swap) throw new NotFoundException('Swap not found');
    return swap;
  }

  /**
   * Every item of the swap that Square knows, deleted ones too (D2): a sale
   * stays a sale after its item is withdrawn, and its category with it.
   */
  private soldItems(swapId: string, orgId: string) {
    return this.prisma.swapItem.findMany({
      where: { swapId, orgId, squareVariationId: { not: null } },
      select: { squareVariationId: true, categoryId: true },
    });
  }

  /**
   * Square's sales as every card counts them (Plan 48 D5): the cached read,
   * with what Sales check decided applied. A line credited to an item counts
   * as that item's; one that isn't a swap sale is left out. Decisions are
   * read fresh each time, so a credit shows at once.
   */
  private async sales(orgId: string, swap: { id: string; createdAt: Date; locationId: string }): Promise<SalesRead> {
    const read = await this.rawRead(orgId, swap);
    const decisions = await this.prisma.swapSaleDecision.findMany({
      where: { swapId: swap.id, liveKey: { not: null } },
      select: { orderId: true, lineUid: true, decision: true, itemId: true },
    });
    if (decisions.length === 0) return read;
    const credited = [...new Set(decisions.map((d) => d.itemId).filter((x): x is string => !!x))];
    const items = credited.length
      // Deleted ones too: a credited sale stays a sale after its item goes.
      ? await this.prisma.swapItem.findMany({ where: { id: { in: credited } }, select: { id: true, squareVariationId: true } })
      : [];
    const variationOfItem = new Map(items.filter((i) => i.squareVariationId).map((i) => [i.id, i.squareVariationId!]));
    return {
      at: read.at,
      lines: applyDecisions(read.lines, decisions as DecisionRef[], new Set(), variationOfItem),
    };
  }

  /** Sales check's read (Plan 48): Square's lines as they are, from the same cache. */
  async rawSales(orgId: string, swapId: string): Promise<{ at: number; lines: PosSaleLine[]; swap: Awaited<ReturnType<ItemBreakdownService['swapOf']>> }> {
    const swap = await this.swapOf(orgId, swapId);
    const read = await this.rawRead(orgId, swap);
    return { ...read, swap };
  }

  /** Drops the cached read, after a decision, so every card reads afresh. */
  forgetSales(swapId: string): void {
    this.salesCache.delete(swapId);
  }

  /** Square's sales for the swap's whole life, reused for two minutes. */
  private rawRead(orgId: string, swap: { id: string; createdAt: Date; locationId: string }): Promise<SalesRead> {
    const cached = this.salesCache.get(swap.id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.read;
    const at = Date.now();
    const read = (async (): Promise<SalesRead> => {
      if (!swap.locationId) throw new Error('This swap has no Square location, so its sales can’t be read.');
      const pos = await this.pos.forOrg(orgId);
      if (!pos) throw new Error('Square isn’t connected, so sales can’t be read.');
      return { at, lines: await pos.listSales(swap.locationId, swap.createdAt, new Date(at)) };
    })();
    this.salesCache.set(swap.id, { at, read });
    // A failed read isn't kept: the next card asks again.
    read.catch(() => { if (this.salesCache.get(swap.id)?.read === read) this.salesCache.delete(swap.id); });
    return read;
  }
}
