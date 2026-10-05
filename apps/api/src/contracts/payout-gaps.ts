/**
 * Why a seller can't be paid, and what staff do about it.
 *
 * One rule, read by the server (the Sellers list's "Cannot be paid" filter and
 * the dashboard's count) and by the web (which says, per seller, what to fix).
 * Kept free of imports so the web can use it as is.
 *
 * A seller can be paid when they have a mailing address, which a check or
 * their unsold items go to, and a payout the run can actually send (Plan 35):
 * PayPal to a verified email, a Venmo account scanned at the counter, a check,
 * or a donation.
 */

/** The fields the rule reads, a subset of `SellerResponse`. */
export interface PayoutGapSeller {
  email: string | null;
  emailVerifiedAt: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payoutMethod: 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE' | null;
  payoutTarget: 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'VENMO_ID' | null;
  payoutHandleScanned: boolean;
}

export interface PayoutGap {
  key: 'ADDRESS' | 'NO_METHOD' | 'PAYPAL_NO_EMAIL' | 'PAYPAL_NOT_EMAIL' | 'PAYPAL_UNVERIFIED' | 'VENMO_UNSCANNED';
  /** What's wrong: "No ZIP code". */
  problem: string;
  /** What to do, in a sentence: "Add it in Edit Seller." */
  fix: string;
}

const ADDRESS_PARTS: [keyof PayoutGapSeller, string][] = [
  ['street', 'street'],
  ['city', 'city'],
  ['state', 'state'],
  ['zip', 'ZIP code'],
];

/** "street, city and ZIP code" */
function listed(parts: string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export function payoutGaps(s: PayoutGapSeller): PayoutGap[] {
  const gaps: PayoutGap[] = [];

  const missing = ADDRESS_PARTS.filter(([field]) => !s[field]).map(([, label]) => label);
  if (missing.length === ADDRESS_PARTS.length) {
    gaps.push({ key: 'ADDRESS', problem: 'No mailing address', fix: 'Add their address in Edit Seller.' });
  } else if (missing.length > 0) {
    gaps.push({
      key: 'ADDRESS',
      problem: `Address has no ${listed(missing)}`,
      fix: `Add the ${listed(missing)} in Edit Seller.`,
    });
  }

  switch (s.payoutMethod) {
    case null:
      gaps.push({
        key: 'NO_METHOD',
        problem: 'No payout method',
        fix: 'Ask how they want to be paid, and choose it under Payout in Edit Seller.',
      });
      break;
    case 'PAYPAL':
      if (s.payoutTarget !== 'EMAIL') {
        // From before Plan 35: a phone or a typed PayPal ID, which the run won't pay.
        gaps.push({
          key: 'PAYPAL_NOT_EMAIL',
          problem: 'PayPal to a phone or PayPal ID, which can’t be paid',
          fix: 'In Edit Seller, verify their email (press Verify beside it and have them confirm), then press Pay to their email under Payout.',
        });
      } else if (!s.email) {
        gaps.push({
          key: 'PAYPAL_NO_EMAIL',
          problem: 'PayPal, but no email',
          fix: 'Add their email in Edit Seller, then press Verify and have them confirm it.',
        });
      } else if (!s.emailVerifiedAt) {
        gaps.push({
          key: 'PAYPAL_UNVERIFIED',
          problem: 'PayPal email not verified',
          fix: 'Press Verify beside their email in Edit Seller, and have them confirm it.',
        });
      }
      break;
    case 'VENMO':
      if (!s.payoutHandleScanned) {
        gaps.push({
          key: 'VENMO_UNSCANNED',
          problem: 'Venmo never scanned',
          fix: 'Scan their Venmo code on the staff iPad.',
        });
      }
      break;
  }

  return gaps;
}
