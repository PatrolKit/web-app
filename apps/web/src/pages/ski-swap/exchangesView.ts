import type { ExchangeItem, ExchangeLookupLine, SwapExchangeResponse } from '../../lib/api.types';
import { money, type Side } from './salesCheckView';

/**
 * Exchanges (Plan 49), kept apart from the page so it can be tested: what a
 * typed search means, the card's two sides, the warnings, and the list's words.
 */

/**
 * What the one box was typed as: a ticket (digits) or a receipt (four
 * letters and digits, as printed, with or without #). Four digits could be
 * either, so it asks for both. Null when it can't be either.
 */
export function lookupQuery(typed: string): { receipt?: string; ticket?: string } | null {
  const t = typed.trim().replace(/^#/, '');
  if (!t) return null;
  const receipt = /^[A-Za-z0-9]{4}$/.test(t) ? t : undefined;
  const ticket = /^\d{3,8}$/.test(t) ? t : undefined;
  return receipt || ticket ? { ...(receipt ? { receipt } : {}), ...(ticket ? { ticket } : {}) } : null;
}

/** Going out less coming back, in words: who pays for the difference. Null when either is unpriced. */
export function differenceText(cents: number | null): string | null {
  if (cents === null) return null;
  if (cents === 0) return 'Same price: nothing changes hands.';
  return cents > 0
    ? `The patrol absorbs ${money(cents)}: the item going out lists higher, and its seller is paid its price.`
    : `The patrol keeps ${money(-cents)}: the item going out lists lower.`;
}

/** The short form, for the list. */
export function differenceShort(cents: number | null): string | null {
  if (cents === null || cents === 0) return cents === 0 ? 'Same price' : null;
  return cents > 0 ? `Patrol absorbed ${money(cents)}` : `Patrol kept ${money(-cents)}`;
}

/** D8: the sale and its payout move to another seller. Null when it's the same one. */
export function sellerWarning(from: ExchangeItem, to: ExchangeItem): string | null {
  if (from.sellerId === to.sellerId) return null;
  return `Different sellers: the sale and its payout move from ${from.sellerName ?? 'no seller'} to ${to.sellerName ?? 'no seller'}.`;
}

const priceOf = (cents: number | null) => (cents === null ? 'Unpriced' : money(cents));
const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** The left of the card: the sale, and the item coming back. */
export function comingBackSide(line: ExchangeLookupLine): Side {
  return {
    title: 'Coming back',
    fields: [
      { label: 'Ticket', value: line.item.sku, mono: true },
      { label: 'Item', value: line.item.name },
      { label: 'Seller', value: line.item.sellerName ?? '—' },
      { label: 'Price', value: priceOf(line.item.priceCents) },
      ...(line.receipt ? [{ label: 'Receipt', value: `#${line.receipt}`, mono: true }] : []),
      { label: 'Sold', value: `${when(line.soldAt)} · paid ${money(line.collectedCents)}` },
    ],
    links: line.links.sale ? [{ label: 'Sale in Square', href: line.links.sale }] : [],
  };
}

/** The right of the card: the item going out, once picked. */
export function goingOutSide(item: ExchangeItem | null, sellerName?: string | null): Side {
  if (!item) return { title: 'Going out', fields: [], links: [], empty: 'Pick the item the customer is leaving with.' };
  return {
    title: 'Going out',
    fields: [
      { label: 'Ticket', value: item.sku, mono: true },
      { label: 'Item', value: item.name },
      { label: 'Seller', value: item.sellerName ?? sellerName ?? '—' },
      { label: 'Price', value: priceOf(item.priceCents), warn: item.priceCents === null },
    ],
    links: [],
  };
}

export function statusOf(e: SwapExchangeResponse): { label: string; tone: string } {
  if (e.status === 'cancelled') return { label: 'Cancelled', tone: 'bg-gray-700/50 text-gray-300' };
  if (e.status === 'superseded') return { label: 'Replaced by a later exchange', tone: 'bg-gray-700/50 text-gray-300' };
  if (!e.stockSynced) return { label: 'Square’s stock not updated', tone: 'bg-amber-900/40 text-amber-300' };
  return { label: 'Live', tone: 'bg-green-900/40 text-green-400' };
}

/** The list's search: ticket (either side), receipt, or seller. */
export function matches(e: SwapExchangeResponse, q: string): boolean {
  const t = q.trim().replace(/^#/, '').toLowerCase();
  if (!t) return true;
  return [e.returned.sku, e.replacement.sku, e.receipt ?? '', e.returned.sellerName ?? '', e.replacement.sellerName ?? '', e.returned.name, e.replacement.name]
    .some((s) => s.toLowerCase().includes(t));
}

/** The tombstone once recorded: what happened, in one line. */
export function recordedText(line: ExchangeLookupLine, out: ExchangeItem): string {
  return `Recorded: ${line.item.sku} back for sale; ${out.sku} sold${line.receipt ? ` on receipt #${line.receipt}` : ''}.`;
}
