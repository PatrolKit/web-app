/**
 * Translating between our payout record and PayPal's (Plan 25 §7, §11).
 *
 * Pure, and separate from the client, because these are the two places a
 * mistake is silent: a destination built wrong sends money to the wrong place,
 * and a status read wrong says money arrived when it did not.
 */

/** What PayPal calls the state of one payout item. All nine of them. */
export const PAYPAL_ITEM_STATUSES = [
  'SUCCESS', 'FAILED', 'PENDING', 'UNCLAIMED', 'RETURNED',
  'ONHOLD', 'BLOCKED', 'REFUNDED', 'REVERSED',
] as const;
export type PayPalItemStatus = (typeof PAYPAL_ITEM_STATUSES)[number];

/** What we call it. */
export type LineStatus =
  | 'PENDING' | 'APPROVED' | 'SENDING' | 'SENT' | 'UNCLAIMED'
  | 'FAILED' | 'RETURNED' | 'PAID_BY_CHECK' | 'DONATED' | 'BELOW_MINIMUM';

export interface MappedStatus {
  status: LineStatus;
  /** True once nothing further will happen without somebody doing something. */
  terminal: boolean;
  note?: string;
}

/**
 * Reads a PayPal item status.
 *
 * Throws on anything unrecognised rather than guessing. A status PayPal adds
 * later must stop a run and be looked at — defaulting it to `SENT` would report
 * money as delivered on the strength of a string nobody has read.
 */
export function mapItemStatus(raw: string): MappedStatus {
  switch (raw) {
    case 'SUCCESS':
      return { status: 'SENT', terminal: true };
    case 'UNCLAIMED':
      return { status: 'UNCLAIMED', terminal: false };
    case 'RETURNED':
    case 'REVERSED':
    case 'REFUNDED':
      return { status: 'RETURNED', terminal: true, note: `PayPal reported ${raw}` };
    case 'FAILED':
    case 'BLOCKED':
      return { status: 'FAILED', terminal: true, note: `PayPal reported ${raw}` };
    case 'PENDING':
      return { status: 'SENDING', terminal: false };
    case 'ONHOLD':
      // Named rather than lumped with PENDING: PayPal describes it as under
      // review, which can sit for days, and a treasurer asking why it has not
      // landed deserves better than a spinner.
      return { status: 'SENDING', terminal: false, note: 'PayPal has this item under review' };
    default:
      throw new Error(`Unrecognised PayPal payout item status: ${raw}`);
  }
}

// ─── Destinations ────────────────────────────────────────────────────────────

export type PayoutMethod = 'PAYPAL' | 'VENMO' | 'CHECK' | 'DONATE';
export type PayoutTarget = 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'VENMO_ID';
export type RecipientType = 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'USER_HANDLE';

export interface Recipient {
  recipient_type: RecipientType;
  receiver: string;
  /** Only for Venmo. Absent means PayPal's own wallet, which is the default. */
  recipient_wallet?: 'Venmo';
}

/**
 * Where one payout is going, in PayPal's words.
 *
 * `VENMO_ID` becomes `USER_HANDLE` — the handle collected at check-in is
 * payable as it stands (§11). Note that PayPal's published OpenAPI spec omits
 * `USER_HANDLE`; the documentation has it, and the documentation is right.
 */
export function buildRecipient(
  method: PayoutMethod,
  target: PayoutTarget | null,
  destination: string,
): Recipient {
  if (method === 'VENMO') {
    // Venmo is addressed by handle here regardless of `target`, because a Venmo
    // seller is only ever asked for one thing.
    return {
      recipient_type: 'USER_HANDLE',
      receiver: normaliseVenmoHandle(destination),
      recipient_wallet: 'Venmo',
    };
  }
  if (method !== 'PAYPAL') {
    throw new Error(`${method} payouts do not go through PayPal`);
  }
  switch (target) {
    case 'EMAIL':
      return { recipient_type: 'EMAIL', receiver: destination };
    case 'PHONE':
      return { recipient_type: 'PHONE', receiver: destination };
    case 'PAYPAL_ID':
      return { recipient_type: 'PAYPAL_ID', receiver: destination };
    default:
      throw new Error(`A PayPal payout needs a destination type, got ${target}`);
  }
}

/**
 * One form of a handle, whichever way it was typed.
 *
 * Whether PayPal wants the `@` is unstated in their documentation, so it is
 * stripped here and the client adds whichever form sandbox testing settles on.
 * What matters is that two sellers who typed it differently are not paid
 * differently.
 */
export function normaliseVenmoHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '');
}
