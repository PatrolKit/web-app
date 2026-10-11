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
    kind: 'scanned_twice', title: 'Scanned twice in one sale',
    explain: 'The ticket was rung up more than once in the same sale: twice, as a quantity of 2, or again on another copy. Each ticket is one item, so either the customer paid for it twice (refund the extra in Square; it leaves this list once Square shows the refund) or another item was rung up under this ticket (check the receipt and the stubs, and note which ticket it was).',
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
    explain: 'The ticket sold in two different sales, but each ticket is one item: one sale was really another ticket, or the first was returned without a refund in Square. Check the receipts and stubs, and note what you find. If an accepted suggestion caused it, undo that below.',
  },
  {
    kind: 'price_paid', title: 'Sold for a different price',
    explain: 'Rung up at another price than PatrolKit’s, typed at the register or discounted. The seller is paid PatrolKit’s price, so the difference is the patrol’s. If the price paid was right, set PatrolKit’s price to it and the seller is paid that; if not, keep PatrolKit’s.',
  },
  {
    kind: 'unknown_ticket', title: 'A ticket PatrolKit doesn’t have',
    explain: 'The number isn’t one of this swap’s tickets. Find its seller from the stub, then issue it to them: the new item is priced at what Square sold it for, in PatrolKit and Square, and the sale goes on it.',
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

/** The SKU an issue is about: the suggested item's, else the ticket's, else what Square rang up. */
export function skuOf(i: SalesCheckIssue): string | null {
  return i.suggestion?.sku ?? i.oversold?.sku ?? i.paid?.sku ?? i.ticket ?? (i.rungUpAs?.sku || null);
}

/** By SKU, as numbers read (9001 before 73338); those with none last, by when they sold. */
export function bySku(a: SalesCheckIssue, b: SalesCheckIssue): number {
  const x = skuOf(a);
  const y = skuOf(b);
  if (x && y) return x.localeCompare(y, 'en', { numeric: true }) || a.soldAt.localeCompare(b.soldAt);
  if (x || y) return x ? -1 : 1;
  return a.soldAt.localeCompare(b.soldAt);
}

/** `done`: sales decided on this page since it loaded, counted out but still shown. Each group by SKU. */
export function groupsOf(issues: SalesCheckIssue[], done: ReadonlySet<string> = new Set()): SalesCheckGroup[] {
  return ORDER.flatMap((g) => {
    const mine = issues.filter((i) => i.kind === g.kind).sort(bySku);
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
  /** A link after the value, e.g. a receipt's "View in Square". */
  link?: { label: string; href: string };
}

/** A receipt's sale in Square: shown after the number, never as a refund. */
const viewInSquare = (href: string | null | undefined) => (href ? { link: { label: 'View in Square', href } } : {});

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
        ...(i.receipt ? [{ label: 'Receipt', value: `#${i.receipt}`, mono: true, ...viewInSquare(i.links.sale) }] : []),
        { label: 'Paid', value: paid || '—' },
        { label: i.fee.shopFeeName, value: money(i.fee.shopFeeCents) },
        ...(i.fee.surchargeCents !== null ? [{ label: 'Surcharge', value: money(i.fee.surchargeCents) }] : []),
      ],
      // The receipt's "View in Square" is the link; without one, the sale's.
      links: i.links.sale && !i.receipt ? [{ label: 'Sale', href: i.links.sale }] : [],
    };
  }
  const links: SideLink[] = [];
  if (i.links.sale && !i.receipt) links.push({ label: 'Sale', href: i.links.sale });
  if (i.links.item) links.push({ label: 'Item', href: i.links.item });

  if (i.paid) {
    const p = i.paid;
    const discounted = p.rungCents !== null && p.rungCents !== p.paidCents;
    return {
      title: 'Sale in Square',
      fields: [
        ...(i.receipt ? [{ label: 'Receipt', value: `#${i.receipt}`, mono: true, ...viewInSquare(i.links.sale) }] : []),
        ...(discounted ? [{ label: 'Rung up at', value: money(p.rungCents!) }] : []),
        { label: 'Paid', value: `${money(p.paidCents)}${i.quantity > 1 ? ' each' : ''}`, warn: true, ...(discounted ? { tag: 'after a discount' } : {}) },
      ],
      links,
    };
  }

  if (i.oversold) return repeatSales(i.kind, i.oversold);

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
      ...(i.receipt ? [{ label: 'Receipt', value: `#${i.receipt}`, mono: true, ...viewInSquare(i.links.sale) }] : []),
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
      links: [],
    };
  }
  if (i.paid) {
    const p = i.paid;
    const links: SideLink[] = [itemLink(p.sku)];
    if (p.sellerId) links.push({ label: 'Seller', to: `/dashboard/ski-swap/sellers?edit=${encodeURIComponent(p.sellerId)}` });
    return {
      title: 'PatrolKit item',
      fields: [
        { label: 'SKU', value: p.sku, mono: true },
        { label: 'Name', value: p.name },
        { label: 'Seller', value: p.sellerName ?? '—' },
        { label: 'Price', value: money(p.priceCents), warn: true, tag: 'the seller is paid this' },
      ],
      links,
    };
  }
  if (i.oversold) {
    return {
      title: 'PatrolKit item',
      fields: [
        { label: 'SKU', value: i.oversold.sku, mono: true },
        { label: 'Name', value: i.oversold.name },
        { label: 'Seller', value: i.oversold.sellerName ?? '—' },
        { label: 'Price', value: i.oversold.priceCents === null ? 'unpriced' : money(i.oversold.priceCents) },
        { label: 'Checked in', value: String(i.oversold.quantity) },
      ],
      links: [itemLink(i.oversold.sku)],
    };
  }
  const s = i.suggestion;
  if (s && i.kind === 'scanned_twice') {
    return {
      title: 'Already sold in this sale',
      fields: [
        { label: 'SKU', value: s.sku, mono: true },
        { label: 'Name', value: s.name },
        { label: 'Seller', value: s.sellerName ?? '—' },
        { label: 'Price', value: s.priceCents === null ? 'unpriced' : money(s.priceCents) },
      ],
      links: [itemLink(s.sku)],
    };
  }
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
/** A sale paid at another price: what each button sets, and what a tombstone says. */
export function paidPriceButtons(p: NonNullable<SalesCheckIssue['paid']>) {
  return { keep: `Keep PatrolKit price (${money(p.priceCents)})`, use: `Set PatrolKit price to ${money(p.paidCents)}` };
}
export function paidPriceDoneText(p: NonNullable<SalesCheckIssue['paid']>, choice: 'keep' | 'use'): string {
  return choice === 'keep'
    ? `Kept PatrolKit’s price for ${p.sku}: ${money(p.priceCents)}, though it sold for ${money(p.paidCents)}.`
    : `Set ${p.sku}’s PatrolKit price to ${money(p.paidCents)}, what it sold for; Square’s left as it sold.`;
}

export function missedFeesText(m: { orders: number; cardCents: number; feeCents: number | null; percentage: string | null } | null): string | null {
  if (!m || m.orders === 0) return null;
  const about = m.feeCents !== null && m.percentage ? ` (about ${money(m.feeCents)} at ${m.percentage}%)` : '';
  return `${m.orders.toLocaleString('en-US')} card sale${m.orders === 1 ? ' was' : 's were'} charged no fee${about}. Counted here, not flagged.`;
}

type Repeat = NonNullable<SalesCheckIssue['oversold']>;

/**
 * A ticket rung up more times than it has units: each sale that counts it,
 * with its receipt and a link to view it in Square.
 */
function repeatSales(kind: SalesCheckIssue['kind'], o: Repeat): Side {
  const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const one = kind === 'scanned_twice';
  const fields: Field[] = o.sales.map((s, n) => ({
    label: one ? `Line ${n + 1}` : s.receipt ? `#${s.receipt}` : `Sale ${n + 1}`,
    value: `${money(s.collectedCents)}${s.quantity > 1 ? ` (×${s.quantity})` : ''}${one ? '' : ` · ${when(s.soldAt)}`}`,
    warn: true,
    ...(one ? {} : viewInSquare(s.link)),
  }));
  const first = o.sales[0];
  const head: Field[] = one && first
    ? [{ label: 'Receipt', value: first.receipt ? `#${first.receipt}` : '—', mono: true, ...viewInSquare(first.link) }, { label: 'When', value: when(first.soldAt) }]
    : [];
  return { title: one ? 'Rung up in one sale' : 'Sold in different sales', fields: [...head, ...fields], links: [] };
}

