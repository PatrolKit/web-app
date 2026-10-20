import { payoutGaps, type PayoutGap, type PayoutGapSeller } from '../../contracts/payout-gaps';
import type { SalesCheckIssue } from '../../contracts/sales-check.contracts';
import type { PayoutFlag, PayoutLineStatus, PayoutRunKind } from '../../contracts/payouts.contracts';
import { NOT_PAID_STATUSES } from '../../contracts/payouts.contracts';
import { formatCents } from './money';

/**
 * What stops a seller being paid in a run (Plan 52 D8, D14, D16). Pure, so the
 * rules can be read and tested apart from the database and Square.
 */

export type PayoutMethodChoice = 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE' | null;

/** Which kind of run pays a method (D1). Donate, and no method, are paid by neither. */
export function kindOf(method: PayoutMethodChoice | string | null): PayoutRunKind | null {
  if (method === 'CHECK') return 'CHECK';
  if (method === 'PAYPAL' || method === 'VENMO') return 'PAYPAL';
  return null;
}

/**
 * The gaps that stop a seller's own payout method (D16): an address only
 * matters for a check, and a donor needs nothing.
 */
export function gapsForPayout(s: PayoutGapSeller): PayoutGap[] {
  const gaps = payoutGaps(s);
  switch (s.payoutMethod) {
    case 'DONATE': return [];
    case 'CHECK': return gaps;
    case null: return gaps.filter((g) => g.key === 'NO_METHOD');
    default: return gaps.filter((g) => g.key !== 'ADDRESS');
  }
}

/** One open Sales check issue that bears on a seller's payout. */
export interface SellerIssue { sku: string | null; kind: SalesCheckIssue['kind']; text: string }

/** Fee checks are about the patrol's fees, not anybody's payout. */
const FEE_KINDS: SalesCheckIssue['kind'][] = ['double_fee', 'cash_fee'];

/**
 * Open Sales check issues, by the seller they bear on (D8), and the ones that
 * name no seller: sales that matched no ticket, which nobody is paid for until
 * they're settled (D14).
 */
export function issuesBySeller(
  issues: SalesCheckIssue[],
  items: { id: string; sku: string; sellerId: string | null }[],
): { bySeller: Map<string, SellerIssue[]>; unmatched: SalesCheckIssue[] } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const bySku = new Map(items.map((i) => [i.sku, i]));
  const bySeller = new Map<string, SellerIssue[]>();
  const unmatched: SalesCheckIssue[] = [];

  for (const issue of issues) {
    if (FEE_KINDS.includes(issue.kind)) continue;
    const item =
      (issue.paid && byId.get(issue.paid.itemId)) ||
      (issue.oversold && byId.get(issue.oversold.itemId)) ||
      (issue.suggestion && byId.get(issue.suggestion.itemId)) ||
      (issue.ticket && bySku.get(issue.ticket)) ||
      (issue.rungUpAs?.itemId && byId.get(issue.rungUpAs.itemId)) ||
      null;
    const sellerId = issue.paid?.sellerId ?? issue.suggestion?.sellerId ?? item?.sellerId ?? null;
    if (!sellerId) {
      unmatched.push(issue);
      continue;
    }
    const list = bySeller.get(sellerId) ?? [];
    list.push({ sku: item?.sku ?? issue.ticket ?? null, kind: issue.kind, text: issueText(issue) });
    bySeller.set(sellerId, list);
  }
  return { bySeller, unmatched };
}

/** What an issue says on a seller's card. */
export function issueText(issue: SalesCheckIssue): string {
  switch (issue.kind) {
    case 'price_paid':
      return issue.paid
        ? `Sold for ${formatCents(issue.paid.paidCents)}; PatrolKit says ${formatCents(issue.paid.priceCents)}`
        : 'Sold for a different price';
    case 'oversold':
      // `units`: sold; `quantity`: checked in.
      return issue.oversold ? `Sold ${issue.oversold.units} times in different sales; checked in ${issue.oversold.quantity}` : 'Sold more times than it was checked in';
    case 'scanned_twice':
      return 'Scanned twice in one sale';
    case 'other_copy':
      return 'Another copy of this ticket was rung up';
    default:
      return 'An open Sales check sale on their ticket';
  }
}

/** The flags on a seller in a run, every one blocking (D8). */
export function flagsFor(input: {
  kind: PayoutRunKind;
  method: PayoutMethodChoice;
  gaps: PayoutGap[];
  issues: SellerIssue[];
  /** Tickets sold with no price, PatrolKit's or the register's. */
  unpriced: string[];
  /** Tickets rung up more times than checked in (Plan 48's held sales). */
  held: string[];
  netCents: number;
}): PayoutFlag[] {
  const flags: PayoutFlag[] = input.gaps.map((g) => ({ text: g.problem, fix: g.fix }));

  const runKind = kindOf(input.method);
  if (input.method !== null && runKind !== input.kind) {
    flags.push({
      text: input.method === 'DONATE' ? 'Now donating their payout' : `Wrong run: now paid by ${methodLabel(input.method)}`,
      fix: 'Remove them, and add them to a run of the right kind.',
    });
  }

  const covered = new Set<string>();
  for (const i of input.issues) {
    if (i.sku) covered.add(i.sku);
    flags.push({
      text: `${i.sku ? `${i.sku}: ` : ''}${i.text}`,
      fix: i.kind === 'price_paid' ? 'In Sales check, keep PatrolKit’s price or set it from the sale.' : 'Settle it in Sales check.',
    });
  }
  // Held and unpriced sales usually show in Sales check too; flagged here only
  // when they don't, so one problem isn't listed twice.
  for (const sku of new Set(input.held)) {
    if (!covered.has(sku)) flags.push({ text: `${sku}: counted as sold twice`, fix: 'Settle it in Sales check.' });
  }
  for (const sku of new Set(input.unpriced)) {
    if (!covered.has(sku)) flags.push({ text: `${sku}: sold with no price`, fix: 'Price it on the Items page, or settle it in Sales check.' });
  }

  if (input.netCents <= 0) flags.push({ text: 'Nothing owed', fix: 'Everything was refunded: remove them from the run.' });
  return flags;
}

export function methodLabel(m: PayoutMethodChoice | string | null): string {
  return m === 'PAYPAL' ? 'PayPal' : m === 'VENMO' ? 'Venmo' : m === 'CHECK' ? 'Check' : m === 'DONATE' ? 'Donate' : 'not chosen';
}

/** A payment that ended without paying them (D19). */
export function notPaid(status: string): boolean {
  return (NOT_PAID_STATUSES as readonly string[]).includes(status);
}

/** Every payment in a PayPal run is final: paid, failed, returned or cancelled (D15). */
export function allFinal(statuses: string[]): boolean {
  return statuses.length > 0 && statuses.every((s) => s === 'SENT' || notPaid(s as PayoutLineStatus));
}

/** `swapId:sellerId`, the key that keeps a seller in one run of a swap at a time (D4). */
export function activeKeyOf(swapId: string, sellerId: string): string {
  return `${swapId}:${sellerId}`;
}
