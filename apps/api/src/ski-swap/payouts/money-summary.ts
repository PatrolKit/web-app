import type { PosOrderFees, PosSaleLine } from '../pos/pos.adapter';
import { netOf } from '../sales-heatmap';
import { COMP_ORDER_PREFIX, isComp } from '../sales-check';
import type { BuiltLine } from './build-run';

/**
 * The swap's money, for the Payouts page:
 *   incoming = swap sales, less returns, + shop and convenience fees − Square's fees
 *   outgoing = (item prices + comped items) × (1 − the patrol's take), sellers paid
 *   profit   = incoming − outgoing
 *
 * Swap sales are what the register took for the swap's tickets (after Sales
 * check and exchanges), not swag or other items. Fees, both the ones charged
 * and Square's processing fees, count for the orders that sold a swap ticket.
 * Outgoing is what sellers are owed for what sold; a seller who donated is
 * paid nothing, so their items are counted apart.
 */
export interface MoneySummary {
  incoming: {
    /** What the register took for swap tickets, before returns. */
    salesCents: number;
    /** What returns gave back of that. */
    returnsCents: number;
    /** Shop Fee and Square's card surcharge, less what was refunded. */
    feesChargedCents: number;
    /** What Square kept for processing card payments, less what it gave back. */
    squareFeesCents: number;
    totalCents: number;
  };
  outgoing: {
    /** Sold tickets at their prices, comps apart. */
    itemsCents: number;
    compsCents: number;
    /** The patrol's take, in basis points (2000 = 20%), and its amount. */
    takeBps: number;
    takeCents: number;
    totalCents: number;
    /** Sold by sellers who donated their payout: not paid out. */
    donatedCents: number;
  };
  profitCents: number;
  /** Profit as a share of incoming, or null when nothing came in. */
  profitShare: number | null;
}

export function moneySummary(input: {
  sales: PosSaleLine[];
  ourVariations: ReadonlySet<string>;
  fees: PosOrderFees[] | null;
  lines: BuiltLine[];
  takeBps: number;
}): MoneySummary {
  let salesCents = 0;
  let netCents = 0;
  const swapOrders = new Set<string>();
  for (const line of input.sales) {
    if (isComp(line) || !input.ourVariations.has(line.variationId)) continue;
    salesCents += line.collectedCents;
    netCents += netOf(line).cents;
    swapOrders.add(line.orderId);
  }
  let feesChargedCents = 0;
  let squareFeesCents = 0;
  for (const f of input.fees ?? []) {
    if (!swapOrders.has(f.orderId)) continue;
    for (const c of f.charges) feesChargedCents += c.cents - c.refundedCents;
    squareFeesCents += (f.processingFeeCents ?? 0) - (f.processingFeeRefundedCents ?? 0);
  }
  const incoming = netCents + feesChargedCents - squareFeesCents;

  let itemsCents = 0;
  let compsCents = 0;
  let takeCents = 0;
  let outgoing = 0;
  let donatedCents = 0;
  for (const l of input.lines) {
    if (l.method === 'DONATE') { donatedCents += l.grossCents; continue; }
    for (const i of l.items) {
      const cents = i.priceCents * i.quantity;
      if (i.squareOrderId.startsWith(COMP_ORDER_PREFIX)) compsCents += cents;
      else itemsCents += cents;
    }
    takeCents += l.commissionCents;
    outgoing += l.netCents;
  }

  const profitCents = incoming - outgoing;
  return {
    incoming: { salesCents, returnsCents: salesCents - netCents, feesChargedCents, squareFeesCents, totalCents: incoming },
    outgoing: { itemsCents, compsCents, takeBps: input.takeBps, takeCents, totalCents: outgoing, donatedCents },
    profitCents,
    profitShare: incoming !== 0 ? profitCents / incoming : null,
  };
}
