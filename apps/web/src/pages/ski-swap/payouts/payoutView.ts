import { faMoneyCheckDollarPen } from '@fortawesome/pro-duotone-svg-icons';
import { faPaypal } from '@awesome.me/kit-9b475e388e/icons/classic/brands';
import type { PayoutLineStatus, PayoutMethod, PayoutRunKind, PayPalFeeRate } from '../../../lib/api.types';
import { usd } from '../../../lib/money';

/**
 * The payout run screens' rules, as they show them (Plan 52). Pure, and tested.
 */

/** Each kind of run's icon and its color, wherever the kind is named. */
export const RUN_KIND_ICON = {
  PAYPAL: { icon: faPaypal, color: 'text-blue-400' },
  CHECK: { icon: faMoneyCheckDollarPen, color: 'text-green-400' },
} as const;

export const methodLabel = (m: PayoutMethod | null) =>
  m === 'PAYPAL' ? 'PayPal' : m === 'VENMO' ? 'Venmo' : m === 'CHECK' ? 'Check' : m === 'DONATE' ? 'Donate' : 'not chosen';

/** One payment's PayPal fee: the flat part, plus the percentage (rounded half up) up to the cap (D17). */
export function feeCents(netCents: number, rate: PayPalFeeRate): number {
  return rate.flatCents + Math.min(Math.round((netCents * rate.bps) / 10_000), rate.capCents);
}

/** "$0.25 a payment", or "2% of each payment, at most $1.00", as the rate stands. */
export function feeRateText(rate: PayPalFeeRate): string {
  const pct = rate.bps ? `${rate.bps / 100}% of each payment${rate.capCents ? `, at most ${usd(rate.capCents)}` : ''}` : '';
  return [rate.flatCents ? `${usd(rate.flatCents)} a payment` : '', pct].filter(Boolean).join(' plus ') || 'no fee';
}

/** What PayPal must hold to send these payments: what the sellers get, plus each payment's fee. */
export function fundingFor(payments: number[], rate: PayPalFeeRate) {
  const toSellers = payments.reduce((n, c) => n + c, 0);
  const fees = payments.reduce((n, c) => n + feeCents(c, rate), 0);
  return { toSellers, fees, total: toSellers + fees };
}

export type SortKey = 'name' | 'owed' | 'items';

/** Name A–Z, amount owed highest first, items most first (D12). Ties by name. */
export function sortSellers<T extends { name: string; netCents: number; items: number }>(rows: T[], key: SortKey): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  return [...rows].sort((a, b) =>
    key === 'owed' ? b.netCents - a.netCents || byName(a, b)
      : key === 'items' ? b.items - a.items || byName(a, b)
        : byName(a, b));
}

/** "Fri, Oct 9, 2:04 PM", in the swap's time zone. */
export function soldAtText(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const whenText = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const dayText = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export type Tone = 'blue' | 'green' | 'amber' | 'red' | 'gray';

export const TONE: Record<Tone, { text: string; dot: string }> = {
  blue: { text: 'text-blue-300', dot: 'bg-blue-400' },
  green: { text: 'text-green-400', dot: 'bg-green-500' },
  amber: { text: 'text-amber-300', dot: 'bg-amber-400' },
  red: { text: 'text-red-300', dot: 'bg-red-400' },
  gray: { text: 'text-gray-400', dot: 'bg-gray-500' },
};

const ELSEWHERE = 'Nothing more happens in this run: add them to another run to pay them.';

/** A line's status in words (D18, D19): a short label, its tone, and what it means. */
export function statusView(status: PayoutLineStatus, kind: PayoutRunKind): { label: string; tone: Tone; detail: string } {
  switch (status) {
    case 'PENDING': return { label: 'Needs review', tone: 'gray', detail: '' };
    case 'APPROVED': return { label: 'Approved', tone: 'green', detail: '' };
    case 'SENDING': return { label: 'Sending', tone: 'blue', detail: 'PayPal is processing it.' };
    case 'SENT': return { label: 'Paid', tone: 'green', detail: '' };
    case 'UNCLAIMED': return { label: 'Unclaimed', tone: 'amber', detail: 'Waiting for them to claim it. PayPal returns it after 30 days if they don’t.' };
    case 'ONHOLD': return { label: 'On hold', tone: 'amber', detail: 'PayPal is reviewing it before releasing it.' };
    case 'FAILED': return { label: 'Failed', tone: 'red', detail: `PayPal couldn’t pay it. ${ELSEWHERE}` };
    case 'RETURNED': return { label: 'Returned', tone: 'red', detail: `Never claimed, so PayPal returned the money. ${ELSEWHERE}` };
    case 'CANCELLED': return { label: 'Cancelled', tone: 'gray', detail: `Cancelled at PayPal; the money came back. ${ELSEWHERE}` };
    case 'EXPORTED': return { label: kind === 'CHECK' ? 'Exported' : 'Paid', tone: 'green', detail: '' };
  }
}

/** A payment that ended without paying them (D19). */
export const NOT_PAID: PayoutLineStatus[] = ['FAILED', 'RETURNED', 'CANCELLED'];

/** "Ann", "Ann and Bo", "Ann, Bo and Cy", or the first five "and 3 more". */
export function namesText(names: string[]): string {
  const shown = names.length > 6 ? [...names.slice(0, 5), `${names.length - 5} more`] : names;
  return shown.length < 2 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** A seller here who wasn't paid, and whether they're left waiting on staff (not paid or in a run since). */
export type UnpaidSeller = { name: string; unresolved: boolean };

/**
 * How a closed run ended, from how many of its payments reached the seller and
 * who wasn't paid (D15, D19): a short label, its tone, and a sentence. Only a
 * seller left waiting on staff makes it a warning; one in another run since is
 * taken care of, as the runs list says. With `paidCents`, the sentence says how
 * much reached them.
 */
export function runOutcome(kind: PayoutRunKind, paid: number, unpaid: UnpaidSeller[], paidCents?: number): { label: string; tone: Tone; text: string } {
  const payments = (n: number) => `${n} ${n === 1 ? 'payment' : 'payments'}`;
  const amount = paidCents === undefined ? '' : `, ${usd(paidCents)}`;
  if (kind === 'CHECK') return { label: 'Exported', tone: 'green', text: `${paid} ${paid === 1 ? 'check' : 'checks'}${amount}, to write from the spreadsheet.` };
  if (unpaid.length === 0) return { label: 'Paid', tone: 'green', text: `Everyone was paid: ${payments(paid)}${amount}.` };

  const waiting = unpaid.filter((u) => u.unresolved).map((u) => u.name);
  const moved = unpaid.filter((u) => !u.unresolved).map((u) => u.name);
  const movedText = moved.length ? `${namesText(moved)} ${moved.length === 1 ? 'is' : 'are'} in another run.` : '';
  const paidText = paid === 0
    ? `Nobody was paid: ${payments(unpaid.length)} failed, returned or cancelled.`
    : `${paid} of ${payments(paid + unpaid.length)} paid${amount}.`;
  if (waiting.length === 0) {
    return { label: `${paid} of ${paid + unpaid.length} paid`, tone: 'gray', text: `${paidText} ${movedText} Nothing’s left to do here.` };
  }
  const waitingText = `Not paid, and not in another run: ${namesText(waiting)}. Add them to another run to pay them.`;
  return {
    label: paid === 0 ? 'Not paid' : 'Partly paid',
    tone: paid === 0 ? 'red' : 'amber',
    text: [paidText, waitingText, movedText].filter(Boolean).join(' '),
  };
}

type RunRow = { kind: PayoutRunKind; status: 'OPEN' | 'CLOSED'; sent: boolean; lineCount: number; paidCount: number };

/** Where a run is: being built, sent and waiting on PayPal, or closed. Check runs aren't sent. */
export function runStage(r: RunRow): 'Open' | 'Processing' | 'Closed' {
  return r.status === 'CLOSED' ? 'Closed' : r.sent ? 'Processing' : 'Open';
}

/** The runs list's Paid column: "Paid", "Exported", "99 of 100", or nothing before it's sent. */
export function runPaidText(r: RunRow): { text: string; tone: Tone } {
  if (r.kind === 'CHECK') return r.status === 'CLOSED' ? { text: 'Exported', tone: 'green' } : { text: '—', tone: 'gray' };
  if (!r.sent) return { text: '—', tone: 'gray' };
  if (r.lineCount > 0 && r.paidCount === r.lineCount) return { text: 'Paid', tone: 'green' };
  return { text: `${r.paidCount} of ${r.lineCount}`, tone: 'gray' };
}

/** PayPal's batch status in plain words (D18). */
export function batchStatusText(status: string | null): string {
  switch (status) {
    case 'PENDING': return 'Waiting on PayPal';
    case 'PROCESSING': return 'PayPal is processing it';
    case 'SUCCESS': return 'Processed';
    case 'DENIED': return 'Refused by PayPal';
    case 'CANCELED': return 'Cancelled by PayPal';
    default: return status ?? 'Not sent';
  }
}

/** "20%", "12.3%", "−4.5%": a share as people say it, to a tenth at most. */
export function percentText(share: number): string {
  const pct = Math.round(share * 1000) / 10;
  return `${pct < 0 ? '−' : ''}${Math.abs(pct)}%`;
}
