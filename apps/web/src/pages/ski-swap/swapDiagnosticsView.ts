import { CHOICES_FOR } from '@patrolkit/contracts/swap-diagnostics-choices';
import type {
  DiagnosticChoice, DiagnosticField, DiagnosticIssueKind, DiagnosticIssueResponse, DiagnosticRunResponse,
  DiagnosticSquareSide,
} from '../../lib/api.types';
import type { Side } from './salesCheckView';

/**
 * Swap diagnostics' popover (Plan 41), kept apart from it so it can be
 * tested: a run's issues as groups, each with its wording and its choices.
 */

export interface DiagnosticGroup {
  key: string;
  kind: DiagnosticIssueKind;
  field: DiagnosticField | null;
  title: string;
  /** What it means for the register, and what to do. */
  explain: string;
  issues: DiagnosticIssueResponse[];
  /** Rows still waiting for a choice. */
  open: number;
  /** Open rows an open Sales check sale holds back: no choice until it's settled. */
  held: number;
  /** What the group offers for all its open rows at once (D4). */
  groupChoices: DiagnosticChoice[];
}

/** Most urgent first: what the register can't sell, then what it sells wrongly. */
const ORDER: { kind: DiagnosticIssueKind; field: DiagnosticField | null; title: string; explain: string }[] = [
  {
    kind: 'elsewhere', field: null, title: 'Another Square item has this ticket number',
    explain: 'Last year’s item, or an archived one: Square still scans archived items, so the register can ring a sale up on it, where PatrolKit can’t see it. Delete it, so it no longer scans.',
  },
  {
    kind: 'stock', field: null, title: 'Stock doesn’t match sales',
    explain: 'Square’s stock should be the number checked in, minus the number sold (a refunded sale doesn’t count as sold). These don’t match, usually because a refund wasn’t put back in stock, a ticket was scanned twice, or someone changed the count by hand. At 0, PatrolKit shows the item as sold and the register shows it sold out; below 0 is never right.',
  },
  {
    kind: 'only_ours', field: null, title: 'In PatrolKit, not in Square',
    explain: 'The register can’t sell these. Usually a push to Square that failed, or a self check-in the seller never finished.',
  },
  {
    kind: 'not_linked', field: null, title: 'Not linked to its Square item',
    explain: 'Square has these, but our record doesn’t point at them: the Items page calls them “not in Square”, and their next edit would put a second copy in Square.',
  },
  {
    kind: 'differs', field: 'price', title: 'Price differs',
    explain: 'The register charges Square’s price.',
  },
  {
    kind: 'differs', field: 'name', title: 'Name differs',
    explain: 'The register and receipts show Square’s name; tags and PatrolKit show ours.',
  },
  {
    kind: 'differs', field: 'notes', title: 'Notes differ',
    explain: 'Square’s description isn’t our notes.',
  },
  {
    kind: 'twice', field: null, title: 'In Square more than once',
    explain: 'The register can ring up either copy. Keep one; the others are deleted from Square.',
  },
  {
    kind: 'only_square', field: null, title: 'In Square, not in PatrolKit',
    explain: 'The register can sell these, but no seller would be paid for them.',
  },
  {
    kind: 'returned', field: null, title: 'Returned, still in Square',
    explain: 'Handed back to their sellers, but taking them out of Square failed: the register could still sell them.',
  },
];

export const CHOICE_LABEL: Record<DiagnosticChoice, string> = {
  copy_to_patrolkit: 'Copy to PatrolKit',
  copy_to_square: 'Copy to Square',
  use_square: 'Use Square’s',
  use_ours: 'Use ours',
  link: 'Link to it',
  keep: 'Keep this copy',
  remove_from_square: 'Remove from Square',
  delete_other: 'Delete the other item',
  renumber_other: 'Re-number the other item',
  resolve: 'Mark resolved',
  set_price: 'Set a different price',
  set_stock: 'Set Square’s stock',
};

/**
 * Choices not offered as plain buttons: Keep this copy is one per copy, and
 * Set a different price (and Price differs' own two) live on its card. Price
 * differs isn't Mark resolved: one of the prices has to win.
 */
function offered(c: DiagnosticChoice, kind: DiagnosticIssueKind, field: DiagnosticField | null): boolean {
  // Re-numbering another copy isn't offered: delete it, or leave it resolved.
  if (c === 'keep' || c === 'set_price' || c === 'renumber_other') return false;
  return !(kind === 'differs' && field === 'price' && c === 'resolve');
}

/** The button for a whole group: "Copy all 300 to Square". */
export function groupChoiceLabel(choice: DiagnosticChoice, n: number): string {
  const count = n.toLocaleString('en-US');
  switch (choice) {
    case 'copy_to_square': return `Copy all ${count} to Square`;
    case 'copy_to_patrolkit': return `Copy all ${count} to PatrolKit`;
    case 'use_square': return `Use Square’s for all ${count}`;
    case 'use_ours': return `Use ours for all ${count}`;
    case 'link': return `Link all ${count}`;
    case 'remove_from_square': return `Remove all ${count} from Square`;
    case 'delete_other': return `Delete all ${count} other items`;
    case 'renumber_other': return `Re-number all ${count} other items`;
    case 'set_stock': return `Set Square’s stock for all ${count}`;
    case 'resolve': return `Mark all ${count} resolved`;
    default: return CHOICE_LABEL[choice];
  }
}

/** A copy's category, as a re-number prefix when it's named for a year ("2025"), as the server reads it. */
export function yearOf(category: string | null | undefined): string | null {
  const m = (category ?? '').match(/(?:^|,\s*)((?:19|20)\d{2})(?:$|,)/);
  return m ? m[1] : null;
}

/** A ticket is the one item allowed to be unpriced: a ticket number is digits only. */
export function isTicket(sku: string): boolean {
  return /^\d+$/.test(sku);
}

/**
 * The choices one row offers. "Use Square's" no price only for a ticket (D3);
 * "Keep this copy" is one button per copy, shown with the copies.
 */
export function rowChoices(issue: DiagnosticIssueResponse): DiagnosticChoice[] {
  return CHOICES_FOR[issue.kind].filter((c) => {
    if (!offered(c, issue.kind, issue.field)) return false;
    if (c === 'use_square' && issue.field === 'price') {
      const sq = squareSide(issue);
      return !!sq && (sq.priceCents !== null || isTicket(issue.sku));
    }
    return true;
  });
}

export function squareSide(issue: DiagnosticIssueResponse): DiagnosticSquareSide | null {
  return issue.square && !('copies' in issue.square) ? issue.square : null;
}

export function squareCopies(issue: DiagnosticIssueResponse): DiagnosticSquareSide[] {
  return issue.square && 'copies' in issue.square ? issue.square.copies : [];
}

export function isOpen(issue: DiagnosticIssueResponse): boolean {
  return issue.state === 'open' || issue.state === 'failed';
}

/** Open, but waiting on an open sale in Sales check. */
export function isHeld(issue: DiagnosticIssueResponse): boolean {
  return isOpen(issue) && (issue.heldBySales ?? 0) > 0;
}

/** "Ticket 73308 has 2 open sales in Sales check." */
export function heldText(issue: DiagnosticIssueResponse): string {
  const n = issue.heldBySales ?? 0;
  return `Ticket ${issue.sku} has ${n === 1 ? 'an open sale' : `${n} open sales`} in Sales check. Settle ${n === 1 ? 'it' : 'them'} there first; until then this can’t be changed, so the sale’s evidence stays put.`;
}

export function groupsOf(run: DiagnosticRunResponse): DiagnosticGroup[] {
  return ORDER.flatMap((g) => {
    const issues = run.issues.filter((i) => i.kind === g.kind && (g.kind !== 'differs' || i.field === g.field));
    if (issues.length === 0) return [];
    const open = issues.filter(isOpen).length;
    const held = issues.filter(isHeld).length;
    const groupChoices = CHOICES_FOR[g.kind].filter((c) => offered(c, g.kind, g.field));
    return [{ key: `${g.kind}:${g.field ?? ''}`, ...g, issues, open, held, groupChoices }];
  });
}

/** One side's value, as a row shows it. */
export function shown(field: DiagnosticField | null, value: { name: string; notes: string | null; priceCents: number | null } | null): string {
  if (!value) return '—';
  if (field === 'price') return value.priceCents === null ? 'No price' : `$${(value.priceCents / 100).toFixed(2)}`;
  if (field === 'notes') return value.notes ?? 'No notes';
  return value.name;
}

/** What a decided row says it was. */
export function decidedText(issue: DiagnosticIssueResponse): string {
  const what = issue.state === 'fixed' ? 'Resolved, fixed'
    : issue.state === 'left' ? 'Resolved, left as is'
      : issue.choice === 'set_stock' ? `Set Square’s stock to ${issue.ours?.stock ?? 0}`
        : issue.choice ? CHOICE_LABEL[issue.choice] : 'Done';
  return `${what}${byAt(issue)}`;
}

/** " by Dana, Oct 10, 9:42 PM". */
function byAt(issue: DiagnosticIssueResponse): string {
  const by = issue.decidedByName ? ` by ${issue.decidedByName}` : '';
  const at = issue.decidedAt
    ? `, ${new Date(issue.decidedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : '';
  return `${by}${at}`;
}

/** "took 48 s". */
export function tookText(run: DiagnosticRunResponse): string | null {
  if (!run.finishedAt) return null;
  const s = Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return s < 90 ? `took ${s} s` : `took ${Math.round(s / 60)} min`;
}

/** Price differs: true when Square's price can be used ("no price" only for a ticket). */
export function canUseSquarePrice(issue: DiagnosticIssueResponse): boolean {
  const sq = squareSide(issue);
  return !!sq && (sq.priceCents !== null || isTicket(issue.sku));
}

/** Price differs as a card: Square's item on the left, ours on the right, the prices flagged. */
export function priceSides(issue: DiagnosticIssueResponse): { square: Side; ours: Side } {
  const sq = squareSide(issue);
  const ours = issue.ours && !issue.ours.deleted ? issue.ours : null;
  return {
    square: {
      title: 'Square',
      fields: [
        { label: 'SKU', value: issue.sku, mono: true },
        { label: 'Name', value: sq?.name ?? '—' },
        { label: 'Price', value: shown('price', sq), warn: true },
      ],
      links: issue.squareUrl ? [{ label: 'Item', href: issue.squareUrl }] : [],
    },
    ours: {
      title: 'PatrolKit',
      fields: [
        { label: 'SKU', value: issue.sku, mono: true },
        { label: 'Name', value: ours?.name ?? '—' },
        { label: 'Seller', value: ours?.sellerName ?? '—' },
        { label: 'Price', value: shown('price', ours), warn: true },
      ],
      links: [{ label: 'Item', to: `/dashboard/ski-swap/items?q=${encodeURIComponent(issue.sku)}` }],
    },
  };
}

/** A decided price card's tombstone: what the price is now, and where. */
export function priceDecidedText(issue: DiagnosticIssueResponse, setCents?: number): string {
  const sq = squareSide(issue);
  const ours = issue.ours;
  const now = issue.choice === 'use_square' ? shown('price', sq)
    : issue.choice === 'use_ours' ? shown('price', ours)
      : setCents !== undefined ? `$${(setCents / 100).toFixed(2)}` : null;
  const where = issue.choice === 'use_square' ? 'Used Square’s price' : issue.choice === 'use_ours' ? 'Used PatrolKit’s price' : 'Set a different price';
  return `${where}${now ? `: ${now} in both` : ''}${byAt(issue)}`;
}

/** "$40", "40.5", "40.50" → cents; anything else (or nothing above zero) → null. */
export function centsOf(text: string): number | null {
  const m = text.trim().replace(/^\$/, '').match(/^(\d{1,6})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  return cents > 0 ? cents : null;
}

/** Stock: "Square shows 0 in stock, but should show 1: 1 checked in, 0 sold (a refunded sale doesn’t count)." */
export function stockText(issue: DiagnosticIssueResponse): string {
  const sq = squareSide(issue)?.stock ?? 0;
  const want = issue.ours?.stock ?? 0;
  const sold = issue.ours?.sold ?? 0;
  const checkedIn = issue.ours?.checkedIn ?? want + sold;
  return `Square shows ${sq} in stock, but should show ${want}: ${checkedIn} checked in, ${sold} sold (a refunded sale doesn’t count).`;
}

