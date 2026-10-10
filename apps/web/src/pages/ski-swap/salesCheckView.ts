import type { SalesCheckIssue, SalesCheckKind } from '../../lib/api.types';

/**
 * Sales check (Plan 48), kept apart from the page so it can be tested: the
 * kinds in the order the page shows them, what each means, and the two sides
 * of each card — the sale as Square has it, and PatrolKit's item for it.
 */

export interface SalesCheckGroup {
  kind: SalesCheckKind;
  title: string;
  explain: string;
  /** Open sales and, in place, ones just decided (shown as tombstones). */
  issues: SalesCheckIssue[];
  /** Open sales only. */
  open: number;
  cents: number;
}

/** Most worth fixing first: a seller unpaid for a sale we can place, then what we can't. */
const ORDER: { kind: SalesCheckKind; title: string; explain: string }[] = [
  {
    kind: 'other_copy', title: 'Sold on another copy of a ticket',
    explain: 'The ticket scanned as last year’s item, or a duplicate, so the sale isn’t on this year’s. Its seller won’t be paid for it until it is.',
  },
  {
    kind: 'register_item', title: 'Sold on an item made at the register',
    explain: 'Someone made a new item at the register, named for a ticket. Accept the suggestion so that ticket’s seller is paid.',
  },
  {
    kind: 'double_fee', title: 'Charged both fees',
    explain: 'Square’s credit card surcharge and the Shop Fee were both charged on this sale. In Square, open the sale, choose Issue refund, and refund the Shop Fee only. It leaves this list once Square shows the refund.',
  },
  {
    kind: 'cash_fee', title: 'Shop Fee on a cash sale',
    explain: 'The Shop Fee is for card payments, but this sale was paid all in cash. In Square, refund the Shop Fee only. It leaves this list once Square shows the refund.',
  },
  {
    kind: 'oversold', title: 'Counted as sold more than once',
    explain: 'An item is counted as sold more times than it has. If an accepted suggestion caused it, undo that below. Otherwise open the sale in Square: the ticket may have been scanned twice (refund the extra), or scanned in place of another ticket.',
  },
  {
    kind: 'unknown_ticket', title: 'A ticket PatrolKit doesn’t have',
    explain: 'The number isn’t one of this swap’s tickets. Find its seller from the stub, then issue it to them.',
  },
  {
    kind: 'custom_amount', title: 'Custom amounts',
    explain: 'Typed in at the register, with no item. Pick the item it was for, or say it isn’t a swap sale.',
  },
  {
    kind: 'other_item', title: 'Other items',
    explain: 'Sold at the swap’s location, but not swap items, such as the patrol’s swag. Stop counting a whole Square category, or set single sales aside.',
  },
];

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** `done`: sales decided on this page since it loaded, counted out but still shown. */
export function groupsOf(issues: SalesCheckIssue[], done: ReadonlySet<string> = new Set()): SalesCheckGroup[] {
  return ORDER.flatMap((g) => {
    const mine = issues.filter((i) => i.kind === g.kind);
    const open = mine.filter((i) => !done.has(i.key));
    return mine.length ? [{ ...g, issues: mine, open: open.length, cents: open.reduce((n, i) => n + i.collectedCents, 0) }] : [];
  });
}

/**
 * What the page shows: Square's open sales plus the ones decided here, which
 * stay put as tombstones until the page reloads. `seen` numbers each sale the
 * first time the page sees it, so a decided one keeps its place after the
 * next read from Square leaves it out.
 */
export function withDecided(open: SalesCheckIssue[], decided: ReadonlyMap<string, SalesCheckIssue>, seen: Map<string, number>): SalesCheckIssue[] {
  for (const i of open) if (!seen.has(i.key)) seen.set(i.key, seen.size);
  const openKeys = new Set(open.map((i) => i.key));
  const all = [...open, ...[...decided.values()].filter((i) => !openKeys.has(i.key))];
  return all.sort((a, b) => (seen.get(a.key) ?? Infinity) - (seen.get(b.key) ?? Infinity));
}

/** What a tombstone says. */
export function acceptedText(i: SalesCheckIssue, item: { sku: string; name: string; sellerName?: string | null }, markedSold?: boolean): string {
  return `${money(i.collectedCents)} sale put on ${item.sku} ${item.name}${item.sellerName ? ` · ${item.sellerName}` : ''}${markedSold ? ' · marked sold in Square' : ''}`;
}

export interface Field {
  label: string;
  value: string;
  mono?: boolean;
  /** A small tag after the value, such as "archived · 2025". */
  tag?: string;
  /** Worth a second look, such as a price that differs from what Square charged. */
  warn?: boolean;
}

/** `href` leaves for Square; `to` stays in PatrolKit. */
export type SideLink = { label: string; href: string } | { label: string; to: string };

export interface Side {
  title: string;
  fields: Field[];
  links: SideLink[];
  /** Nothing to show on this side, and why. */
  empty?: string;
}

/** The left of the card: the sale as Square has it. */
export function squareSide(i: SalesCheckIssue): Side {
  if (i.fee) {
    const paid = [i.fee.cardCents ? `${money(i.fee.cardCents)} by card` : null, i.fee.cashCents ? `${money(i.fee.cashCents)} in cash` : null].filter(Boolean).join(', ');
    return {
      title: 'Sale in Square',
      fields: [
        { label: 'Paid', value: paid || '—' },
        { label: i.fee.shopFeeName, value: money(i.fee.shopFeeCents) },
        ...(i.fee.surchargeCents !== null ? [{ label: 'Surcharge', value: money(i.fee.surchargeCents) }] : []),
      ],
      links: i.links.sale ? [{ label: 'Sale', href: i.links.sale }] : [],
    };
  }
  const links: SideLink[] = [];
  if (i.links.sale) links.push({ label: 'Sale', href: i.links.sale });
  if (i.links.item) links.push({ label: 'Item', href: i.links.item });

  if (i.kind === 'oversold' && i.oversold) {
    return {
      title: 'Sold in Square',
      fields: [
        { label: 'Sold', value: `${i.oversold.units} times`, warn: true },
        { label: 'Orders', value: String(i.oversold.orders.length) },
        { label: 'Last for', value: money(i.collectedCents) },
      ],
      links: i.links.sale ? [{ label: 'Last sale', href: i.links.sale }] : [],
    };
  }

  const r = i.rungUpAs;
  const tag = [r?.archived ? 'archived' : null, r?.category].filter(Boolean).join(' · ');
  const each = i.quantity > 1 && i.unitPriceCents !== null ? ` (${i.quantity} × ${money(i.unitPriceCents)})` : '';
  const refunded = i.refundedQuantity > 0 ? `, ${i.refundedQuantity} refunded` : '';
  return {
    title: 'Rung up in Square',
    fields: [
      { label: 'SKU', value: r?.sku || '—', mono: true },
      { label: 'Name', value: i.kind === 'custom_amount' ? 'Custom amount' : r?.name ?? '—', ...(tag ? { tag } : {}) },
      { label: 'Sold for', value: `${money(i.collectedCents)}${each}${refunded}` },
    ],
    links,
  };
}

const itemLink = (sku: string): SideLink => ({ label: 'Item', to: `/dashboard/ski-swap/items?q=${encodeURIComponent(sku)}` });

/** The right of the card: PatrolKit's item for the sale, if there is one. */
export function patrolKitSide(i: SalesCheckIssue): Side {
  if (i.fee) {
    return {
      title: 'To refund',
      fields: [{ label: 'Refund', value: `${money(i.fee.refundCents)} (the ${i.fee.shopFeeName})`, warn: true }],
      links: i.links.sale ? [{ label: 'Refund in Square', href: i.links.sale }] : [],
    };
  }
  if (i.kind === 'oversold' && i.oversold) {
    return {
      title: 'PatrolKit item',
      fields: [
        { label: 'SKU', value: i.oversold.sku, mono: true },
        { label: 'Name', value: i.oversold.name },
        { label: 'Quantity', value: String(i.oversold.quantity) },
      ],
      links: [itemLink(i.oversold.sku)],
    };
  }
  const s = i.suggestion;
  if (!s) {
    return {
      title: 'Suggested PatrolKit item',
      fields: [],
      links: [],
      empty: i.kind === 'unknown_ticket' ? `No ticket ${i.ticket} in this swap.`
        : i.kind === 'other_item' ? 'Not a swap item.'
          : 'No suggestion. Pick the item it was for, or say it isn’t a swap sale.',
    };
  }
  const links: SideLink[] = [itemLink(s.sku)];
  if (s.sellerId) links.push({ label: 'Seller', to: `/dashboard/ski-swap/sellers?edit=${encodeURIComponent(s.sellerId)}` });
  const differs = s.priceCents !== null && i.unitPriceCents !== null && s.priceCents !== i.unitPriceCents;
  return {
    title: 'Suggested PatrolKit item',
    fields: [
      { label: 'SKU', value: s.sku, mono: true },
      { label: 'Name', value: s.name },
      { label: 'Seller', value: s.sellerName ?? '—' },
      { label: 'Price', value: s.priceCents === null ? 'unpriced' : money(s.priceCents), warn: differs },
    ],
    links,
  };
}

export interface CategoryGroup {
  name: string;
  /** What "Never count" ignores; null when the item has no category. */
  categoryId: string | null;
  /** The item names sold, for the collapsed row. */
  names: string[];
  issues: SalesCheckIssue[];
  cents: number;
}

/** Other items, one row per Square category, the biggest first. */
export function byCategory(issues: SalesCheckIssue[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();
  for (const i of issues) {
    const name = i.rungUpAs?.category ?? 'No category';
    const g = groups.get(name) ?? { name, categoryId: i.categoryIds[0] ?? null, names: [], issues: [], cents: 0 };
    g.issues.push(i);
    g.cents += i.collectedCents;
    const item = i.kind === 'custom_amount' ? 'Custom amount' : i.rungUpAs?.name;
    if (item && !g.names.includes(item)) g.names.push(item);
    groups.set(name, g);
  }
  return [...groups.values()].sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));
}

/** "Accept all suggestions": exactly these lines, as the confirmation lists them (D13). */
export function suggestedLines(issues: SalesCheckIssue[]): { orderId: string; lineUid: string; itemId: string; label: string }[] {
  return issues
    .filter((i) => (i.kind === 'other_copy' || i.kind === 'register_item') && i.suggestion)
    .map((i) => ({ orderId: i.orderId, lineUid: i.lineUid, itemId: i.suggestion!.itemId, label: `${money(i.collectedCents)} sale → ${i.suggestion!.sku}` }));
}

/**
 * What Square sold it for, a unit's worth: what "Accept with Square price"
 * gives an unpriced item. Null when the sale says nothing usable.
 */
export function squarePriceOf(i: SalesCheckIssue): number | null {
  const cents = i.unitPriceCents ?? (i.quantity > 0 ? Math.round(i.collectedCents / i.quantity) : null);
  return cents && cents > 0 ? cents : null;
}

/** "97 card sales were charged no fee (about $497.97 at 2.6%)." Null when there are none, or fees weren't read. */
export function missedFeesText(m: { orders: number; cardCents: number; feeCents: number | null; percentage: string | null } | null): string | null {
  if (!m || m.orders === 0) return null;
  const about = m.feeCents !== null && m.percentage ? ` (about ${money(m.feeCents)} at ${m.percentage}%)` : '';
  return `${m.orders.toLocaleString('en-US')} card sale${m.orders === 1 ? ' was' : 's were'} charged no fee${about}. Counted here, not flagged.`;
}

