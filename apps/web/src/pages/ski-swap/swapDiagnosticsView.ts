import { CHOICES_FOR } from '@patrolkit/contracts/swap-diagnostics-choices';
import type {
  DiagnosticChoice, DiagnosticField, DiagnosticIssueKind, DiagnosticIssueResponse, DiagnosticRunResponse,
  DiagnosticSquareSide,
} from '../../lib/api.types';

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
  /** What the group offers for all its open rows at once (D4). */
  groupChoices: DiagnosticChoice[];
}

/** Most urgent first: what the register can't sell, then what it sells wrongly. */
const ORDER: { kind: DiagnosticIssueKind; field: DiagnosticField | null; title: string; explain: string }[] = [
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
];

export const CHOICE_LABEL: Record<DiagnosticChoice, string> = {
  copy_to_patrolkit: 'Copy to PatrolKit',
  copy_to_square: 'Copy to Square',
  use_square: 'Use Square’s',
  use_ours: 'Use ours',
  link: 'Link to it',
  keep: 'Keep this copy',
  resolve: 'Mark resolved',
};

/** The button for a whole group: "Copy all 300 to Square". */
export function groupChoiceLabel(choice: DiagnosticChoice, n: number): string {
  const count = n.toLocaleString('en-US');
  switch (choice) {
    case 'copy_to_square': return `Copy all ${count} to Square`;
    case 'copy_to_patrolkit': return `Copy all ${count} to PatrolKit`;
    case 'use_square': return `Use Square’s for all ${count}`;
    case 'use_ours': return `Use ours for all ${count}`;
    case 'link': return `Link all ${count}`;
    case 'resolve': return `Mark all ${count} resolved`;
    default: return CHOICE_LABEL[choice];
  }
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
    if (c === 'keep') return false;
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

export function groupsOf(run: DiagnosticRunResponse): DiagnosticGroup[] {
  return ORDER.flatMap((g) => {
    const issues = run.issues.filter((i) => i.kind === g.kind && (g.kind !== 'differs' || i.field === g.field));
    if (issues.length === 0) return [];
    const open = issues.filter(isOpen).length;
    const groupChoices = CHOICES_FOR[g.kind].filter((c) => c !== 'keep');
    return [{ key: `${g.kind}:${g.field ?? ''}`, ...g, issues, open, groupChoices }];
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
      : issue.choice ? CHOICE_LABEL[issue.choice] : 'Done';
  const by = issue.decidedByName ? ` by ${issue.decidedByName}` : '';
  const at = issue.decidedAt
    ? `, ${new Date(issue.decidedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : '';
  return `${what}${by}${at}`;
}

/** "took 48 s". */
export function tookText(run: DiagnosticRunResponse): string | null {
  if (!run.finishedAt) return null;
  const s = Math.max(1, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return s < 90 ? `took ${s} s` : `took ${Math.round(s / 60)} min`;
}
