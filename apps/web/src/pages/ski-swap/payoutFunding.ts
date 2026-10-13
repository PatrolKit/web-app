import type { PayoutLine } from '../../lib/api.types';
import { usd } from '../../lib/money';

/**
 * What a run needs in PayPal before it's sent: every Venmo and PayPal line
 * still to go (not yet handed to PayPal), split by method, and what's owed
 * by check, which is paid apart from PayPal. Kept apart from the page so it
 * can be tested.
 */
export interface Funding {
  /** All of it: what to put in PayPal, before PayPal's fees. */
  cents: number;
  venmo: { sellers: number; cents: number };
  paypal: { sellers: number; cents: number };
  /** Of those, the ones with no usable destination yet: they can't be sent until fixed. */
  noDestination: { sellers: number; cents: number };
  /** Owed by check, not marked sent: written apart from PayPal. */
  checks: { sellers: number; cents: number };
}

const toSend = (l: PayoutLine) => (l.method === 'PAYPAL' || l.method === 'VENMO') && (l.status === 'PENDING' || l.status === 'APPROVED');

export function fundingOf(lines: PayoutLine[]): Funding {
  const sum = (ls: PayoutLine[]) => ({ sellers: ls.length, cents: ls.reduce((n, l) => n + l.netCents, 0) });
  const sending = lines.filter(toSend);
  return {
    cents: sum(sending).cents,
    venmo: sum(sending.filter((l) => l.method === 'VENMO')),
    paypal: sum(sending.filter((l) => l.method === 'PAYPAL')),
    noDestination: sum(sending.filter((l) => !l.destination)),
    checks: sum(lines.filter((l) => l.method === 'CHECK' && (l.status === 'PENDING' || l.status === 'APPROVED'))),
  };
}

const sellers = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'seller' : 'sellers'}`;

/** "$36,988.80 to 298 Venmo sellers · $1,457.60 to 10 PayPal sellers", the parts that aren't empty. */
export function fundingSplitText(f: Funding): string {
  return [
    f.venmo.sellers ? `${usd(f.venmo.cents)} to ${sellers(f.venmo.sellers)} on Venmo` : null,
    f.paypal.sellers ? `${usd(f.paypal.cents)} to ${sellers(f.paypal.sellers)} on PayPal` : null,
  ].filter(Boolean).join(' · ');
}

/** Against the PayPal balance, when it could be read: enough, or how much short. */
export function balanceText(needCents: number, availableCents: number | null): { text: string; short: boolean } | null {
  if (availableCents === null) return null;
  const short = needCents - availableCents;
  return short > 0
    ? { text: `PayPal has ${usd(availableCents)} available: ${usd(short)} short, before fees.`, short: true }
    : { text: `PayPal has ${usd(availableCents)} available: enough, before fees.`, short: false };
}
