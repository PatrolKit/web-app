/**
 * Links into the Square Dashboard (Plan 48 D10), built here so the web needs
 * no Square knowledge.
 *
 * The paths are the Dashboard's as of 2026-10 and haven't been confirmed
 * against a live session (Rollout step 1): if Square moves them, this is the
 * one place to change.
 */

export type SquareEnvironment = 'production' | 'sandbox';

export function squareDashboardBase(env: SquareEnvironment | string | null | undefined): string {
  return env === 'sandbox' ? 'https://app.squareupsandbox.com' : 'https://app.squareup.com';
}

/** An item in the Dashboard's item library. */
export function squareItemUrl(env: SquareEnvironment | string | null | undefined, itemId: string | null): string | null {
  return itemId ? `${squareDashboardBase(env)}/dashboard/items/library/${encodeURIComponent(itemId)}` : null;
}

/** A sale: its payment's transaction page when there is one, else the order. */
export function squareSaleUrl(env: SquareEnvironment | string | null | undefined, orderId: string, paymentId: string | null): string {
  const base = squareDashboardBase(env);
  return paymentId
    ? `${base}/dashboard/sales/transactions/${encodeURIComponent(paymentId)}`
    : `${base}/dashboard/orders/overview/${encodeURIComponent(orderId)}`;
}
