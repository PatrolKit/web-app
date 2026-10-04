/**
 * Every limit on the server, in one place (Plan 26).
 *
 * The throttle guard, the per-destination checks and the SMS ceiling read their
 * numbers from here, and so does the Server health page. Otherwise the page and
 * the code are two copies of one table, and they drift the first time a number
 * changes in one of them. `limits-coverage.spec.ts` fails on a limit written
 * anywhere else.
 *
 * The sizing for the per-IP numbers is in the plan's §3: a measured check-in,
 * a generous model of a doors-open rush with everybody on the venue's wifi, and
 * three times that.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What a limit counts per. Shown on the health page. */
export type LimitKeyedBy = 'ip' | 'caller' | 'destination' | 'site';

export interface LimitDefinition {
  label: string;
  limit: number;
  windowMs: number;
  keyedBy: LimitKeyedBy;
}

export const LIMITS = {
  // ── Requests (§8) ─────────────────────────────────────────────────────────
  // Per route. A request whose bearer token verifies is counted against the
  // account or device; anything else against its address.
  'requests.signedIn': {
    label: 'Requests, signed in',
    limit: 600, windowMs: MINUTE, keyedBy: 'caller',
  },
  'requests.anonymous': {
    label: 'Requests, no token',
    limit: 300, windowMs: MINUTE, keyedBy: 'ip',
  },
  // The routes below are per IP whatever token comes with them. They are the
  // front door, where nobody is signed in yet.
  'auth.login': {
    label: 'Sign-in requests',
    limit: 60, windowMs: MINUTE, keyedBy: 'ip',
  },
  'auth.confirm': {
    label: 'Code confirmations',
    limit: 200, windowMs: MINUTE, keyedBy: 'ip',
  },
  'auth.refresh': {
    label: 'Session refreshes',
    limit: 250, windowMs: MINUTE, keyedBy: 'ip',
  },
  'auth.deviceToken': {
    label: 'Device sign-ins',
    limit: 20, windowMs: MINUTE, keyedBy: 'ip',
  },
  'checkin.register': {
    label: 'Check-in registrations',
    limit: 200, windowMs: MINUTE, keyedBy: 'ip',
  },
  'checkin.page': {
    label: 'Check-in page loads',
    limit: 250, windowMs: MINUTE, keyedBy: 'ip',
  },
  'public.reads': {
    label: 'Public lookups and receipts',
    limit: 200, windowMs: MINUTE, keyedBy: 'ip',
  },
  // Tighter, because SKUs are sequential: this slows anyone stepping through a
  // swap's numbers to list what's sold (Plan 33).
  'public.skuLookup': {
    label: 'Public SKU lookups',
    limit: 30, windowMs: MINUTE, keyedBy: 'ip',
  },
  // Every delivery comes from PayPal, so a batch of payouts arrives from one
  // address. Raised rather than skipped: verifying one costs a call to PayPal.
  'webhooks.paypal': {
    label: 'PayPal webhooks',
    limit: 600, windowMs: MINUTE, keyedBy: 'ip',
  },

  // ── Sends (§5, §6, §7) ────────────────────────────────────────────────────
  'codes.perDestination': {
    label: 'Codes to one phone or email',
    limit: 5, windowMs: 15 * MINUTE, keyedBy: 'destination',
  },
  'codes.perDestinationDaily': {
    label: 'Codes to one phone or email, per day',
    limit: 10, windowMs: 24 * HOUR, keyedBy: 'destination',
  },
  'receipts.perDestination': {
    label: 'Receipts a seller sends themselves',
    limit: 3, windowMs: HOUR, keyedBy: 'destination',
  },
  'sms.site': {
    label: 'Texts, whole site',
    limit: 6_000, windowMs: HOUR, keyedBy: 'site',
  },
} as const satisfies Record<string, LimitDefinition>;

export type LimitId = keyof typeof LIMITS;

/** The limits a route can be put under with `@Limit`. */
export type RouteLimitId = {
  [K in LimitId]: (typeof LIMITS)[K]['keyedBy'] extends 'ip' ? K : never;
}[LimitId];

export function limitOf(id: LimitId): LimitDefinition {
  return LIMITS[id];
}

export function isLimitId(value: string): value is LimitId {
  return Object.prototype.hasOwnProperty.call(LIMITS, value);
}
