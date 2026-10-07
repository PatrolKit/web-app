import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PosAdapterFactory, type PosSaleLine } from './pos/pos.adapter';
import { uncategorisedName } from './sku.util';

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

/** How long a read of Square's sales is reused: the dashboard polls, Square shouldn't be. */
const CACHE_MS = 2 * 60 * 1000;

@Injectable()
export class ItemBreakdownService {
  private readonly logger = new Logger(ItemBreakdownService.name);
  private readonly salesCache = new Map<string, { at: number; sold: Map<string, number> }>();

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

    let read: { at: number; sold: Map<string, number> };
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
    return { ...breakdown(items, read.sold), asOf: new Date(read.at).toISOString(), error: null };
  }

  /** Square's sales for the swap's whole life, reused for two minutes. */
  private async sales(orgId: string, swap: { id: string; createdAt: Date; locationId: string }) {
    const cached = this.salesCache.get(swap.id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached;
    if (!swap.locationId) throw new Error('This swap has no Square location, so its sales can’t be read.');
    const pos = await this.pos.forOrg(orgId);
    if (!pos) throw new Error('Square isn’t connected, so sales can’t be read.');
    const at = Date.now();
    const sold = soldByVariation(await pos.listSales(swap.locationId, swap.createdAt, new Date(at)));
    const read = { at, sold };
    this.salesCache.set(swap.id, read);
    return read;
  }
}
