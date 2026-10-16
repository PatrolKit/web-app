import { faMoneyCheckDollarPen } from '@fortawesome/pro-duotone-svg-icons';
import { faPaypal } from '@awesome.me/kit-9b475e388e/icons/classic/brands';
import type { PayoutLineStatus, PayoutMethod, PayoutRunKind, PayPalFeeRate } from '../../../lib/api.types';

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
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
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
