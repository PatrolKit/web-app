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
  /** Null for a legacy ticket not priced before it sold (Plan 32). */
  priceCents: number | null;
  squareVariationId: string | null;
  /** This item's proceeds were given to the patrol. Sold, owed to nobody. */
  donateProceeds: boolean;
  sellerId: string | null;
  /**
   * Units checked in: the most a run pays for (Plan 48). Every ticket is one
   * item, so a ticket rung up twice is paid once and the rest is held.
   */
  originalQuantity: number;
}

/** A seller, and where their money is meant to go. */
export interface RunSeller {
  sellerId: string;
  name: string;
  method: PayoutMethod;
  target: PayoutTarget | null;
  /** A typed PayPal or Venmo id. Null when the destination is a contact. */
  handle: string | null;
  /** The Venmo handle was scanned from the seller's code (Plan 35). */
  handleScanned: boolean;
  verifiedEmail: string | null;
  verifiedPhone: string | null;
}

export interface BuiltLineItem {
  itemId: string;
  name: string;
  sku: string;
  /**
   * The unit price owed on: the item's price, or, for a ticket sold before it
   * was priced, what the clerk typed for this sale (Plan 32).
   */
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
  status: 'PENDING' | 'DONATED';
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
  unmatched: { variationId: string; orderId: string; collectedCents: number; lineUid?: string; name?: string | null }[];
  /**
   * Unpriced tickets that sold at one price typed at the register, which
   * becomes the item's price (Plan 32 D5). One that sold at different prices
   * keeps none, and each sale is owed on its own.
   */
  pricesFromRegister: { itemId: string; priceCents: number }[];
  /**
   * Sales of an unpriced ticket that Square reported without the price typed.
   * Nothing can be owed on those, and paying the rest of the seller's line
   * without them would underpay quietly, so the run isn't built until staff
   * price them. Square includes the price on catalog sales, so this is a guard.
   */
  unpricedSales: { itemId: string; sku: string; orderId: string }[];
  /**
   * Sales not paid because the ticket was rung up more times than it has
   * units (Plan 48): a double charge, or another item rung up under it. Held
   * until it's settled in Sales check, then the run is built again. A priced
   * ticket is paid once and the rest held; an unpriced one rung up at
   * different prices is held whole, since which price is its isn't known.
   */
  held: HeldSale[];
}

export interface HeldSale {
  itemId: string;
  sku: string;
  name: string;
  sellerId: string;
  /** Units held, and what each was rung up at. */
  units: number;
  unitCents: number[];
  orders: string[];
  /** one_sale: rung up more than once in one sale; different_sales; different_prices: an unpriced ticket typed at different prices. */
  reason: 'one_sale' | 'different_sales' | 'different_prices';
}

export interface BuildOptions {
  commissionBasisPoints: number;
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
  const unpricedSales: BuiltRun['unpricedSales'] = [];
  const held: HeldSale[] = [];
  const typedPrices = new Map<string, Set<number>>();
  // Each item's sales, owed on once they're all seen (Plan 48: at most its units).
  const byItem = new Map<string, { item: RunItem; sales: { sale: PosSaleLine; soldQty: number; unitCents: number }[] }>();

  for (const sale of sales) {
    const item = byVariation.get(sale.variationId);
    if (!item || !item.sellerId) {
      unmatched.push({
        variationId: sale.variationId,
        orderId: sale.orderId,
        collectedCents: sale.collectedCents,
        // For Sales check (Plan 48): which line, and what it was rung up as.
        ...(sale.lineUid ? { lineUid: sale.lineUid } : {}),
        ...(sale.name ? { name: sale.name } : {}),
      });
      continue;
    }

    // A returned unit is not a sale. Subtract before anything is owed on it.
    const soldQty = sale.quantity - sale.refundedQuantity;
    if (soldQty <= 0) continue;

    // A price staff entered always wins. A ticket sold before it had one is
    // owed on what the clerk typed for this sale (Plan 32 D4).
    const unitCents = item.priceCents ?? sale.unitPriceCents;
    if (unitCents === null) {
      unpricedSales.push({ itemId: item.id, sku: item.sku, orderId: sale.orderId });
      continue;
    }
    const entry = byItem.get(item.id) ?? { item, sales: [] };
    entry.sales.push({ sale, soldQty, unitCents });
    byItem.set(item.id, entry);
  }

  for (const { item, sales: sold } of byItem.values()) {
    // Never more units than were checked in (Plan 48). The earliest sales
    // are the ones paid; a line is split when only part of it fits.
    const cap = Math.max(0, item.originalQuantity);
    const total = sold.reduce((n, s) => n + s.soldQty, 0);
    let paying = sold.map((s) => ({ ...s, payQty: s.soldQty }));
    if (total > cap) {
      const typed = new Set(sold.map((s) => s.unitCents));
      const orders = [...new Set(sold.map((s) => s.sale.orderId))];
      const inOrder = [...sold].sort((a, b) => a.sale.soldAt.getTime() - b.sale.soldAt.getTime());
      if (item.priceCents === null && typed.size > 1) {
        held.push({ itemId: item.id, sku: item.sku, name: item.name, sellerId: item.sellerId!, units: total, unitCents: inOrder.flatMap((s) => Array(s.soldQty).fill(s.unitCents)), orders, reason: 'different_prices' });
        paying = [];
      } else {
        let left = cap;
        const heldCents: number[] = [];
        paying = inOrder.map((s) => {
          const payQty = Math.min(left, s.soldQty);
          left -= payQty;
          for (let n = payQty; n < s.soldQty; n++) heldCents.push(s.unitCents);
          return { ...s, payQty };
        });
        held.push({ itemId: item.id, sku: item.sku, name: item.name, sellerId: item.sellerId!, units: total - cap, unitCents: heldCents, orders, reason: orders.length === 1 ? 'one_sale' : 'different_sales' });
      }
    }

    for (const { sale, soldQty, unitCents, payQty } of paying) {
      if (payQty <= 0) continue;
      if (item.priceCents === null) {
        const seen = typedPrices.get(item.id) ?? new Set<number>();
        seen.add(unitCents);
        typedPrices.set(item.id, seen);
      }
      const list = owedBySeller.get(item.sellerId!) ?? [];
      list.push({
        itemId: item.id,
        name: item.name,
        sku: item.sku,
        priceCents: unitCents,
        quantity: payQty,
        // For the org's reporting only: the paid share of what the line took.
        collectedCents: payQty === soldQty ? sale.collectedCents : Math.round(sale.collectedCents * (payQty / soldQty)),
        squareOrderId: sale.orderId,
        soldAt: sale.soldAt,
        refundedQty: sale.refundedQuantity,
      });
      owedBySeller.set(item.sellerId!, list);
    }
  }

  const donated = new Set(items.filter((i) => i.donateProceeds).map((i) => i.id));
  const lines: BuiltLine[] = [];

  for (const seller of sellers) {
    const soldItems = owedBySeller.get(seller.sellerId);
    if (!soldItems?.length) continue;

    // The price owed on (listed, or typed for an unpriced ticket), times what
    // actually sold. An item whose proceeds were
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
  const pricesFromRegister = [...typedPrices]
    .filter(([, prices]) => prices.size === 1)
    .map(([itemId, prices]) => ({ itemId, priceCents: [...prices][0] }));
  return { lines, unmatched, pricesFromRegister, unpricedSales, held };
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
    // Only a proven destination is paid (Plan 35). An unscanned Venmo handle,
    // a typed PayPal ID and a phone are only somebody's word for the account,
    // so the line is left with no usable destination for somebody to fix.
    case 'VENMO':
      return seller.handleScanned
        ? { destination: seller.handle, destinationType: 'VENMO_ID' }
        : { destination: null, destinationType: null };
    case 'PAYPAL':
      return seller.target === 'EMAIL'
        ? { destination: seller.verifiedEmail, destinationType: 'EMAIL' }
        : { destination: null, destinationType: null };
  }
}

/** A sale below its listed price. What §5's discount report is built from. */
export interface Discount {
  itemId: string | null;
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
 * The least a line has to look like for a discount to be read off it.
 *
 * Narrower than `BuiltLine` so the report can be run over rows read back from
 * the database as easily as over a run just built — without either side having
 * to pretend to be the other.
 */
export interface DiscountableLine {
  sellerName: string;
  items: {
    itemId: string | null;
    name: string;
    sku: string;
    priceCents: number;
    quantity: number;
    collectedCents: number;
  }[];
}

/**
 * Every line the register took less for than the item listed at (§5).
 *
 * Derived from the same rows the evidence uses, so it cannot disagree with
 * them. Three rules, each of which would otherwise corrupt the total:
 * only downward, refunds excluded, and zero flagged rather than counted.
 */
export function discountsOf(lines: DiscountableLine[]): { discounts: Discount[]; totalGapCents: number } {
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
