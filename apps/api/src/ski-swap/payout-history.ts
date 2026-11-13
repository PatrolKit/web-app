import { addressText } from './payouts/checks-csv';

/**
 * A seller's payout history: each time how they're paid, or where the money
 * goes, changed — who changed it and from what. Kept in the audit log, one row
 * per change, so nothing new is stored on the seller. Pure, and tested.
 *
 * Where the money goes is part of it: PayPal pays the seller's email, so a new
 * email moves a PayPal payout as surely as a new method does, and a check goes
 * to the address on file.
 */

export const PAYOUT_CHANGED = 'ski_swap.seller.payout_changed';

/** How a change was made: staff on the web, a counter iPad, the seller themself, or a merge. */
export type PayoutChangeVia = 'staff' | 'tablet' | 'seller' | 'merge';

export interface PayoutActor {
  via: PayoutChangeVia;
  actorType: 'user' | 'device';
  actorId: string;
}

/** The payout fields as stored on the person, and the contacts a payout can go to. */
export interface PayoutFields {
  payoutMethod: string | null;
  payoutTarget: string | null;
  payoutHandle: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface PayoutState {
  method: string | null;
  /** Where it goes: an email, a phone, a Venmo handle, or a mailing address. */
  destination: string | null;
}

export function payoutState(f: PayoutFields): PayoutState {
  const method = f.payoutMethod;
  switch (method) {
    case 'PAYPAL':
      return { method, destination: f.payoutTarget === 'PHONE' ? f.phone : f.payoutTarget === 'EMAIL' ? f.email : f.payoutHandle };
    case 'VENMO':
      return { method, destination: f.payoutHandle };
    case 'CHECK':
      return { method, destination: addressText(f) };
    default:
      return { method, destination: null };
  }
}

/**
 * The change between two states, or null when the money would go to the same
 * place. `from` is null when no payout was chosen before.
 */
export function payoutChange(before: PayoutFields, after: PayoutFields): { from: PayoutState | null; to: PayoutState } | null {
  const from = payoutState(before);
  const to = payoutState(after);
  if (from.method === to.method && from.destination === to.destination) return null;
  return { from: from.method ? from : null, to };
}
