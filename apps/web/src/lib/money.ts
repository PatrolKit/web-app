/**
 * Money, for screens that show totals rather than prices.
 *
 * The rest of the app writes `(cents / 100).toFixed(2)` inline, which is right
 * for a $45 pair of skis. A payout run adds up to four figures, and `$1250.00`
 * with no separator is a number people misread.
 */
const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function usd(cents: number): string {
  return usdFormat.format(cents / 100);
}
