import type { PosSaleLine } from '../pos/pos.adapter';
import { splitCommission } from './money';
import type { PayoutMethod, PayoutTarget } from './paypal-mapping';

/**
 * Turning a swap's sales into what each seller is owed (Plan 25 §2, §5).
 *
 * Pure: sales in, lines out. Nothing here reads a database or calls a provider,
 * because this is where the amounts are decided and it should be possible to
 * check them by reading rather than by running a swap.
 */

/** A seller's item, as the run needs to see it. */
export interface RunItem {
  id: string;
  name: string;
  sku: string;
  priceCents: number;
  squareVariationId: string | null;
  /** This item's proceeds were given to the patrol. Sold, owed to nobody. */
  donateProceeds: boolean;
  sellerId: string | null;
}

/** A seller, and where their money is meant to go. */
export interface RunSeller {
  sellerId: string;
  name: string;
  method: PayoutMethod;
  target: PayoutTarget | null;
  /** A typed PayPal or Venmo id. Null when the destination is a contact. */
  handle: string | null;
  verifiedEmail: string | null;
  verifiedPhone: string | null;
}

export interface BuiltLineItem {
  itemId: string;
  name: string;
  sku: string;
  priceCents: number;
  quantity: number;
  collectedCents: number;
  squareOrderId: string;
  soldAt: Date;
  refundedQty: number;
}

export interface BuiltLine {
  sellerId: string;
  sellerName: string;
  method: PayoutMethod;
  destination: string | null;
  destinationType: PayoutTarget | null;
  grossCents: number;
  commissionCents: number;
  netCents: number;
  status: 'PENDING' | 'DONATED' | 'BELOW_MINIMUM';
  statusNote: string | null;
  items: BuiltLineItem[];
}

export interface BuiltRun {
  lines: BuiltLine[];
  /**
   * Sales that matched no item of this swap — something rung up by hand, a
   * mis-scan, or another swap's stock at the same location.
   *
   * Reported rather than dropped: an unmatched sale is money the org took that
   * nobody is being paid for, and silence is the one response that guarantees
   * nobody looks.
   */
  unmatched: { variationId: string; orderId: string; collectedCents: number }[];
}

export interface BuildOptions {
  commissionBasisPoints: number;
  /** Below this a payout is held rather than sent (§7). */
  minimumCents: number;
}

/**
 * Builds a run's lines from a swap's items and a window of sales.
 *
 * The amount owed is the item's **listed price**, never what the register took.
 * A discount was the org's to give, and a seller who agreed a price should not
 * discover it was renegotiated without them — so `collectedCents` is carried
 * for the org's own reporting and never multiplied by anything (§2).
 */
export function buildRun(
  items: RunItem[],
  sellers: RunSeller[],
  sales: PosSaleLine[],
  opts: BuildOptions,
): BuiltRun {
  const byVariation = new Map<string, RunItem>();
  for (const item of items) {
    if (item.squareVariationId) byVariation.set(item.squareVariationId, item);
  }

  const owedBySeller = new Map<string, BuiltLineItem[]>();
  const unmatched: BuiltRun['unmatched'] = [];

  for (const sale of sales) {
    const item = byVariation.get(sale.variationId);
    if (!item || !item.sellerId) {
      unmatched.push({
        variationId: sale.variationId,
        orderId: sale.orderId,
        collectedCents: sale.collectedCents,
      });
      continue;
    }

    // A returned unit is not a sale. Subtract before anything is owed on it.
    const soldQty = sale.quantity - sale.refundedQuantity;
    if (soldQty <= 0) continue;

    const list = owedBySeller.get(item.sellerId) ?? [];
    list.push({
      itemId: item.id,
      name: item.name,
      sku: item.sku,
      priceCents: item.priceCents,
      quantity: soldQty,
      collectedCents: sale.collectedCents,
      squareOrderId: sale.orderId,
      soldAt: sale.soldAt,
      refundedQty: sale.refundedQuantity,
    });
    owedBySeller.set(item.sellerId, list);
  }

  const donated = new Set(items.filter((i) => i.donateProceeds).map((i) => i.id));
  const lines: BuiltLine[] = [];

  for (const seller of sellers) {
    const soldItems = owedBySeller.get(seller.sellerId);
    if (!soldItems?.length) continue;

    // Listed price, times what actually sold. An item whose proceeds were
    // given to the patrol is still evidence — it appears on the line at zero,
    // so a seller can see it sold and see why it paid nothing.
    const grossCents = soldItems.reduce(
      (sum, i) => sum + (donated.has(i.itemId) ? 0 : i.priceCents * i.quantity),
      0,
    );

    const split = splitCommission(grossCents, opts.commissionBasisPoints);
    const { destination, destinationType } = resolveDestination(seller);

    let status: BuiltLine['status'] = 'PENDING';
    let statusNote: string | null = null;

    if (seller.method === 'DONATE') {
      status = 'DONATED';
      statusNote = 'The seller gave this payout to the patrol';
    } else if (seller.method !== 'CHECK' && split.netCents < opts.minimumCents) {
      // Sending forty cents costs more than it is worth. Held rather than
      // batched, and visible, because the alternative is finding it as a fee.
      status = 'BELOW_MINIMUM';
      statusNote = `Below the ${opts.minimumCents / 100} dollar minimum for an electronic payout`;
    } else if (seller.method !== 'CHECK' && !destination) {
      // Not refused at the batch, where it would fail one item of many, but
      // here, where somebody is looking at a screen and can fix it.
      status = 'PENDING';
      statusNote = 'No usable destination — check this seller\'s payout details';
    }

    lines.push({
      sellerId: seller.sellerId,
      sellerName: seller.name,
      method: seller.method,
      destination,
      destinationType,
      ...split,
      status,
      statusNote,
      items: soldItems,
    });
  }

  // Largest first: the biggest payment is the one worth checking hardest.
  lines.sort((a, b) => b.netCents - a.netCents);
  return { lines, unmatched };
}

/**
 * Where this seller's money goes, resolved now rather than at send time.
 *
 * Plan 13 stores no handle for a contact destination so a stale copy cannot be
 * paid to — the address is read from the verified contact when the money moves.
 * Building the run *is* that moment, and freezing it here means a seller who
 * changes their email mid-run cannot redirect a payment already approved.
 */
export function resolveDestination(
  seller: RunSeller,
): { destination: string | null; destinationType: PayoutTarget | null } {
  switch (seller.method) {
    case 'CHECK':
    case 'DONATE':
      return { destination: null, destinationType: null };
    case 'VENMO':
      return { destination: seller.handle, destinationType: 'VENMO_ID' };
    case 'PAYPAL':
      switch (seller.target) {
        case 'EMAIL':
          return { destination: seller.verifiedEmail, destinationType: 'EMAIL' };
        case 'PHONE':
          return { destination: seller.verifiedPhone, destinationType: 'PHONE' };
        case 'PAYPAL_ID':
          return { destination: seller.handle, destinationType: 'PAYPAL_ID' };
        default:
          return { destination: null, destinationType: null };
      }
  }
}

/** A sale below its listed price. What §5's discount report is built from. */
export interface Discount {
  itemId: string;
  name: string;
  sku: string;
  sellerName: string;
  listedCents: number;
  collectedCents: number;
  gapCents: number;
  /** Collected nothing at all: a give-away, or a match against the wrong item. */
  zeroCollected: boolean;
}

/**
 * Every line the register took less for than the item listed at (§5).
 *
 * Derived from the same rows the evidence uses, so it cannot disagree with
 * them. Three rules, each of which would otherwise corrupt the total:
 * only downward, refunds excluded, and zero flagged rather than counted.
 */
export function discountsOf(lines: BuiltLine[]): { discounts: Discount[]; totalGapCents: number } {
  const discounts: Discount[] = [];

  for (const line of lines) {
    for (const item of line.items) {
      // A refunded unit collected nothing by definition; counting it here would
      // report the whole price as given away.
      if (item.quantity <= 0) continue;

      const listedCents = item.priceCents * item.quantity;
      const gapCents = listedCents - item.collectedCents;
      // Collected *above* list is a register mistake or a tip, not a discount.
      // Netting the two together would hide both.
      if (gapCents <= 0) continue;

      discounts.push({
        itemId: item.itemId,
        name: item.name,
        sku: item.sku,
        sellerName: line.sellerName,
        listedCents,
        collectedCents: item.collectedCents,
        gapCents,
        zeroCollected: item.collectedCents === 0,
      });
    }
  }

  discounts.sort((a, b) => b.gapCents - a.gapCents);
  // Zero-collected lines are flagged, not totalled: they are as likely to be a
  // bad catalog match as a deliberate give-away, and those want different
  // responses.
  const totalGapCents = discounts
    .filter((d) => !d.zeroCollected)
    .reduce((sum, d) => sum + d.gapCents, 0);

  return { discounts, totalGapCents };
}
