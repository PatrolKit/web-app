import type { SalesCheckIssue, SalesCheckKind } from '../../lib/api.types';

/**
 * Sales check (Plan 48), kept apart from the page so it can be tested: the
 * kinds in the order the page shows them, what each means, and the sentence
 * each issue reads as.
 */

export interface SalesCheckGroup {
  kind: SalesCheckKind;
  title: string;
  explain: string;
  issues: SalesCheckIssue[];
  cents: number;
}

/** Most worth fixing first: a seller unpaid for a sale we can place, then what we can't. */
const ORDER: { kind: SalesCheckKind; title: string; explain: string }[] = [
  {
    kind: 'other_copy', title: 'Sold on another copy of a ticket',
    explain: 'The ticket scanned as last year’s item, or a duplicate, so the sale isn’t on this year’s. Its seller won’t be paid for it until it’s credited.',
  },
  {
    kind: 'register_item', title: 'Sold on an item made at the register',
    explain: 'Someone made a new item at the register, named for a ticket. Credit it to that ticket so its seller is paid.',
  },
  {
    kind: 'oversold', title: 'Counted as sold more than once',
    explain: 'An item is counted as sold more times than it has. Undo one of the credits below.',
  },
  {
    kind: 'unknown_ticket', title: 'A ticket PatrolKit doesn’t have',
    explain: 'The number isn’t one of this swap’s tickets. Find its seller from the stub, then issue it to them.',
  },
  {
    kind: 'custom_amount', title: 'Custom amounts',
    explain: 'Typed in at the register, with no item. Credit one to the item it was for, or say it isn’t a swap sale.',
  },
  {
    kind: 'other_item', title: 'Other items',
    explain: 'Sold at the swap’s location, but not a swap item, such as the patrol’s swag. Say so, or stop counting the whole category.',
  },
];

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function groupsOf(issues: SalesCheckIssue[]): SalesCheckGroup[] {
  return ORDER.flatMap((g) => {
    const mine = issues.filter((i) => i.kind === g.kind);
    return mine.length ? [{ ...g, issues: mine, cents: mine.reduce((n, i) => n + i.collectedCents, 0) }] : [];
  });
}

/** What happened, in a sentence. */
export function sentence(i: SalesCheckIssue): string {
  const amount = money(i.collectedCents);
  const on = i.rungUpAs ? `“${i.rungUpAs.name}”` : 'nothing';
  switch (i.kind) {
    case 'other_copy':
      return `Ticket ${i.suggestion?.sku} was rung up on ${on}${i.rungUpAs?.archived ? ', an archived item' : ''}${i.rungUpAs?.category ? ` in “${i.rungUpAs.category}”` : ''}, for ${amount}. It isn’t on ${i.suggestion?.sellerName ? `${i.suggestion.sellerName}’s` : 'this swap’s'} item.`;
    case 'register_item':
      return `Rung up as ${on}, made at the register, for ${amount}. It looks like ticket ${i.suggestion?.sku}${i.suggestion?.sellerName ? `, ${i.suggestion.sellerName}’s` : ''} “${i.suggestion?.name}”.`;
    case 'unknown_ticket':
      return `Ticket ${i.ticket} isn’t in PatrolKit. It sold as ${on} for ${amount}.`;
    case 'custom_amount':
      return `A custom amount of ${amount} was typed in at the register.`;
    case 'other_item':
      return `Sold ${on}${i.rungUpAs?.category ? ` (${i.rungUpAs.category})` : ''} for ${amount}, which isn’t a swap item.`;
    case 'oversold':
      return `${i.oversold?.name} (${i.oversold?.sku}) is counted as sold ${i.oversold?.units} times, but has ${i.oversold?.quantity}.`;
  }
}

/** "Credit all suggested": exactly these lines, as the confirmation lists them (D13). */
export function suggestedLines(issues: SalesCheckIssue[]): { orderId: string; lineUid: string; itemId: string; label: string }[] {
  return issues
    .filter((i) => (i.kind === 'other_copy' || i.kind === 'register_item') && i.suggestion)
    .map((i) => ({ orderId: i.orderId, lineUid: i.lineUid, itemId: i.suggestion!.itemId, label: `${i.suggestion!.sku} ← ${money(i.collectedCents)} sale` }));
}
