import type { PosSaleLine, PosVariationInfo } from './pos/pos.adapter';
import { ticketNumberOf } from './legacy-ticket.service';

/**
 * Sales check (Plan 48), kept pure so it can be tested: which of Square's sale
 * lines aren't on this swap's items, what each one looks like, and what a
 * person has decided about it.
 *
 * Nothing here reads or writes anything (D13): the service hands it what it
 * read, and only a person's choice, through the service, changes anything.
 */

export type SalesCheckKind = 'other_copy' | 'register_item' | 'scanned_twice' | 'unknown_ticket' | 'custom_amount' | 'other_item' | 'oversold' | 'double_fee' | 'cash_fee';

/** A decision as attribution needs it: the line, and what it was decided to be. */
export interface DecisionRef {
  orderId: string;
  lineUid: string;
  /** FEE_HANDLED: a fee check marked handled; its line (`#fee`) is no sale line. */
  decision: 'CREDIT' | 'NOT_SWAP' | 'FEE_HANDLED';
  itemId: string | null;
}

export const lineKeyOf = (orderId: string, lineUid: string) => `${orderId}:${lineUid}`;

/** Units a line still stands for, after refunds. */
export const netUnits = (l: Pick<PosSaleLine, 'quantity' | 'refundedQuantity'>) => Math.max(0, l.quantity - l.refundedQuantity);

/**
 * The sale lines as every reader should see them (D5): a line credited to an
 * item counts as that item's, by pointing it at the item's variation; a line
 * that isn't a swap sale is dropped. A line already on one of our items is
 * left alone, whatever was decided about it.
 *
 * Every reader matches lines to items by variation, so this one step makes a
 * credit a sale on the dashboard, in payouts and in the totals at once.
 */
export function applyDecisions(
  lines: PosSaleLine[],
  decisions: DecisionRef[],
  ourVariations: Set<string>,
  variationOfItem: Map<string, string>,
): PosSaleLine[] {
  if (decisions.length === 0) return lines;
  const byKey = new Map(decisions.map((d) => [lineKeyOf(d.orderId, d.lineUid), d]));
  const out: PosSaleLine[] = [];
  for (const line of lines) {
    const d = line.lineUid && !ourVariations.has(line.variationId) ? byKey.get(lineKeyOf(line.orderId, line.lineUid)) : undefined;
    if (!d) { out.push(line); continue; }
    if (d.decision === 'NOT_SWAP') continue;
    const variation = d.itemId ? variationOfItem.get(d.itemId) : undefined;
    out.push(variation ? { ...line, variationId: variation } : line);
  }
  return out;
}

/** One of our items, as Sales check needs it. */
export interface CheckItem {
  id: string;
  sku: string;
  name: string;
  priceCents: number | null;
  sellerName: string | null;
  sellerId: string | null;
  squareVariationId: string | null;
  originalQuantity: number;
  deleted: boolean;
}

/** What a line was rung up on, as shown. */
export interface RungUpAs {
  name: string;
  sku: string;
  variationId: string;
  itemId: string | null;
  category: string | null;
  archived: boolean;
}

export interface SalesCheckIssue {
  key: string;
  kind: SalesCheckKind;
  orderId: string;
  lineUid: string;
  soldAt: string;
  quantity: number;
  refundedQuantity: number;
  collectedCents: number;
  unitPriceCents: number | null;
  paymentId: string | null;
  rungUpAs: RungUpAs | null;
  /** D8: the item the evidence points to exactly. Only ever a button's label. */
  suggestion: { itemId: string; sku: string; name: string; priceCents: number | null; sellerName: string | null; sellerId: string | null } | null;
  /** unknown_ticket: the number no item of this swap has. */
  ticket: string | null;
  /** oversold: the item, and every order line that counts it. */
  oversold?: { itemId: string; sku: string; name: string; units: number; quantity: number; orders: string[] };
}

export interface ClassifyInput {
  lines: PosSaleLine[];
  items: CheckItem[];
  /** Live decisions only. */
  decisions: DecisionRef[];
  described: Map<string, PosVariationInfo>;
  categoryNames: Map<string, string>;
  ignoredCategoryIds: Set<string>;
}

/**
 * Numbers that could be tickets, standing on their own in a name or SKU:
 * "86882 roxa raven 2" → ["86882"], "Swap Item 59443" → ["59443"]. Not one
 * fused to letters or a hyphen, so swag's "TSH-1938" and a typo'd "E6882" are
 * no ticket.
 */
export function ticketNumbersIn(text: string): string[] {
  return [...new Set((text.match(/(?<![A-Za-z0-9-])\d{4,7}(?![A-Za-z0-9-])/g) ?? []).filter((n) => ticketNumberOf(n) !== null))];
}

/** Every open issue, in the order the page groups them. */
export function classify(input: ClassifyInput): SalesCheckIssue[] {
  const ours = new Map(input.items.filter((i) => i.squareVariationId).map((i) => [i.squareVariationId!, i]));
  const liveBySku = new Map(input.items.filter((i) => !i.deleted).map((i) => [i.sku, i]));
  const decided = new Set(input.decisions.map((d) => lineKeyOf(d.orderId, d.lineUid)));
  const issues: SalesCheckIssue[] = [];

  // Units of each of our items an order already sold: on the item itself, or
  // put on it in Sales check. A ticket scanned again in the same order, onto
  // another copy, is a second scan, not a second sale (unless the item has
  // units to spare).
  const soldInOrder = new Map<string, number>();
  const addSold = (orderId: string, itemId: string, units: number) => {
    const k = `${orderId}\u0000${itemId}`;
    soldInOrder.set(k, (soldInOrder.get(k) ?? 0) + units);
  };
  for (const l of input.lines) {
    const our = ours.get(l.variationId);
    if (our) addSold(l.orderId, our.id, netUnits(l));
  }
  const unitsByLine = new Map(input.lines.map((l) => [lineKeyOf(l.orderId, l.lineUid ?? ''), netUnits(l)]));
  for (const d of input.decisions) {
    if (d.decision === 'CREDIT' && d.itemId) addSold(d.orderId, d.itemId, unitsByLine.get(lineKeyOf(d.orderId, d.lineUid)) ?? 1);
  }
  const alreadySold = (orderId: string, item: CheckItem) => (soldInOrder.get(`${orderId}\u0000${item.id}`) ?? 0) >= item.originalQuantity;
  const suggest = (i: CheckItem) => ({ itemId: i.id, sku: i.sku, name: i.name, priceCents: i.priceCents, sellerName: i.sellerName, sellerId: i.sellerId });

  for (const line of input.lines) {
    if (ours.has(line.variationId)) continue;                      // ours: nothing to check
    if (!line.lineUid) continue;                                    // can't be decided about
    const key = lineKeyOf(line.orderId, line.lineUid);
    if (decided.has(key)) continue;
    if (netUnits(line) === 0 && line.collectedCents === 0) continue; // refunded whole

    const info = line.variationId ? input.described.get(line.variationId) : undefined;
    if (info && info.categoryIds.some((c) => input.ignoredCategoryIds.has(c))) continue;

    const rungUpAs: RungUpAs | null = line.variationId
      ? {
          name: info?.itemName || line.name || '',
          sku: info?.sku ?? '',
          variationId: line.variationId,
          itemId: info?.itemId ?? null,
          category: info?.categoryIds.map((c) => input.categoryNames.get(c) ?? c).join(', ') || null,
          archived: info?.archived ?? false,
        }
      : null;
    const base = {
      key, orderId: line.orderId, lineUid: line.lineUid, soldAt: line.soldAt.toISOString(),
      quantity: line.quantity, refundedQuantity: line.refundedQuantity, collectedCents: line.collectedCents,
      unitPriceCents: line.unitPriceCents, paymentId: line.paymentId ?? null, rungUpAs, suggestion: null, ticket: null,
    };

    if (!line.variationId) { issues.push({ ...base, kind: 'custom_amount' }); continue; }

    // Another copy of one of our tickets: the exact SKU (D8).
    const sameSku = info?.sku ? liveBySku.get(info.sku) : undefined;
    if (sameSku) { issues.push({ ...base, kind: alreadySold(line.orderId, sameSku) ? 'scanned_twice' : 'other_copy', suggestion: suggest(sameSku) }); continue; }

    // A register-made item named or numbered for exactly one of our tickets.
    const text = `${info?.itemName ?? line.name ?? ''} ${info?.sku ?? ''}`;
    const numbers = ticketNumbersIn(text);
    const matched = numbers.filter((n) => liveBySku.has(n));
    if (matched.length === 1) {
      const it = liveBySku.get(matched[0])!;
      issues.push({ ...base, kind: alreadySold(line.orderId, it) ? 'scanned_twice' : 'register_item', suggestion: suggest(it) });
      continue;
    }

    // A ticket number no item of ours has.
    const unknown = numbers.filter((n) => !liveBySku.has(n));
    if (matched.length === 0 && unknown.length === 1) { issues.push({ ...base, kind: 'unknown_ticket', ticket: unknown[0] }); continue; }

    issues.push({ ...base, kind: 'other_item' });
  }

  return [...issues, ...oversold(input)];
}

/** Items counted as sold more times than they have units: directly, or by credits. */
function oversold(input: ClassifyInput): SalesCheckIssue[] {
  const ourVariations = new Set(input.items.map((i) => i.squareVariationId).filter((v): v is string => !!v));
  const variationOfItem = new Map(input.items.filter((i) => i.squareVariationId).map((i) => [i.id, i.squareVariationId!]));
  const attributed = applyDecisions(input.lines, input.decisions, ourVariations, variationOfItem);
  const byVariation = new Map<string, PosSaleLine[]>();
  for (const l of attributed) if (ourVariations.has(l.variationId) && netUnits(l) > 0) byVariation.set(l.variationId, [...(byVariation.get(l.variationId) ?? []), l]);
  const out: SalesCheckIssue[] = [];
  for (const item of input.items) {
    const lines = item.squareVariationId ? byVariation.get(item.squareVariationId) ?? [] : [];
    const units = lines.reduce((n, l) => n + netUnits(l), 0);
    if (units <= item.originalQuantity) continue;
    const last = lines[lines.length - 1];
    out.push({
      key: `oversold:${item.id}`, kind: 'oversold', orderId: last.orderId, lineUid: last.lineUid ?? '', soldAt: last.soldAt.toISOString(),
      quantity: units, refundedQuantity: 0, collectedCents: lines.reduce((n, l) => n + l.collectedCents, 0), unitPriceCents: null,
      paymentId: last.paymentId ?? null, rungUpAs: null, suggestion: null, ticket: null,
      oversold: { itemId: item.id, sku: item.sku, name: item.name, units, quantity: item.originalQuantity, orders: [...new Set(lines.map((l) => l.orderId))] },
    });
  }
  return out;
}

/**
 * What open sales hold back (Catalog check): each ticket and Square item an
 * open Sales check sale involves, with the sales. A catalog fix on one of
 * them waits until those sales are settled, so it can't move or delete what
 * the sale is evidence of.
 */
export interface SalesHolds {
  byTicket: Map<string, Set<string>>;
  byItem: Map<string, Set<string>>;
}

type HoldingIssue = Pick<SalesCheckIssue, 'key' | 'suggestion' | 'ticket' | 'oversold' | 'rungUpAs'>;

export function salesHolds(issues: HoldingIssue[]): SalesHolds {
  const holds: SalesHolds = { byTicket: new Map(), byItem: new Map() };
  const add = (m: Map<string, Set<string>>, id: string | null | undefined, key: string) => {
    if (!id) return;
    const s = m.get(id) ?? new Set<string>();
    s.add(key);
    m.set(id, s);
  };
  for (const i of issues) {
    add(holds.byTicket, i.suggestion?.sku, i.key);
    add(holds.byTicket, i.ticket, i.key);
    add(holds.byTicket, i.oversold?.sku, i.key);
    add(holds.byTicket, i.rungUpAs?.sku, i.key);
    for (const n of ticketNumbersIn(`${i.rungUpAs?.name ?? ''} ${i.rungUpAs?.sku ?? ''}`)) add(holds.byTicket, n, i.key);
    add(holds.byItem, i.rungUpAs?.itemId, i.key);
  }
  return holds;
}

/** How many open sales hold back a catalog issue on this ticket and these Square items. */
export function heldBy(holds: SalesHolds, sku: string, squareItemIds: string[]): number {
  const keys = new Set(holds.byTicket.get(sku) ?? []);
  for (const id of squareItemIds) for (const k of holds.byItem.get(id) ?? []) keys.add(k);
  return keys.size;
}
