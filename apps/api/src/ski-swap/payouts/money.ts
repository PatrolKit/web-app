/**
 * The arithmetic that decides what somebody is paid (Plan 25 §3).
 *
 * Pure, and kept apart from everything that talks to a database or a payment
 * provider, because it is the part that has to be right and the part worth
 * testing exhaustively.
 */

/** Hundredths of a percent. 2000 is 20%. */
export type BasisPoints = number;

/**
 * "20.5" → 2050.
 *
 * Rounded rather than truncated, because `20.1 * 100` is 2010.0000000000002 —
 * a float is exactly what the integer exists to keep out, and it sneaks back in
 * at the one place a percent is parsed.
 *
 * Returns null for anything that is not a percentage between 0 and 100 with at
 * most two decimals. Two decimals is what basis points can express, and a
 * third would be silently rounded into a number the person did not type.
 */
export function percentToBasisPoints(input: string | number): BasisPoints | null {
  const text = String(input).trim().replace(/%$/, '');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value * 100);
}

/**
 * 2050 → "20.5%", 2000 → "20%".
 *
 * No trailing zeros: a patrol that set twenty percent should not be shown
 * "20.00%" and wonder what the hundredths are doing.
 */
export function basisPointsToPercent(bps: BasisPoints): string {
  return `${bps / 100}%`;
}

export interface Split {
  grossCents: number;
  commissionCents: number;
  netCents: number;
}

/**
 * Splits a seller's total between them and the patrol.
 *
 * Multiplies before dividing, and rounds once. Never `gross * (bps / 10_000)`,
 * which reaches for a float before it reaches a rounding rule.
 *
 * Half goes up, to the patrol. Applied to a seller's total rather than to each
 * item, so a hundred items do not accumulate a hundred half-cent decisions —
 * `commissionOf(100, 2050)` is one rounding, not a hundred.
 */
export function splitCommission(grossCents: number, bps: BasisPoints): Split {
  if (!Number.isInteger(grossCents) || grossCents < 0) {
    throw new Error(`grossCents must be a non-negative integer, got ${grossCents}`);
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error(`basis points must be an integer 0–10000, got ${bps}`);
  }
  const commissionCents = Math.round((grossCents * bps) / 10_000);
  return { grossCents, commissionCents, netCents: grossCents - commissionCents };
}

/** `1234` → `"12.34"`. For a CSV, where a formatted currency string is a trap. */
export function centsToDecimalString(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** `$1,234.50`, for a screen. Never for a file something else will parse. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
