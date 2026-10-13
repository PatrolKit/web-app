import { describe, expect, it } from 'vitest';
import type { PayoutLine } from '../../lib/api.types';
import { balanceText, fundingOf, fundingSplitText } from './payoutFunding';

const line = (method: PayoutLine['method'], status: PayoutLine['status'], netCents: number, destination: string | null = 'x'): PayoutLine =>
  ({ id: `${method}-${status}-${netCents}`, method, status, netCents, destination } as PayoutLine);

describe('what a run needs in PayPal', () => {
  const lines = [
    line('VENMO', 'PENDING', 8000), line('VENMO', 'APPROVED', 2000), line('PAYPAL', 'PENDING', 1500, null),
    line('VENMO', 'SENDING', 9900), line('PAYPAL', 'SENT', 7700), line('VENMO', 'FAILED', 500),
    line('CHECK', 'PENDING', 6400, null), line('CHECK', 'PAID_BY_CHECK', 3000, null), line('DONATE', 'DONATED', 0, null),
  ];

  it('counts every Venmo and PayPal line not yet handed to PayPal, and checks apart', () => {
    expect(fundingOf(lines)).toEqual({
      cents: 11500,
      venmo: { sellers: 2, cents: 10000 },
      paypal: { sellers: 1, cents: 1500 },
      noDestination: { sellers: 1, cents: 1500 },
      checks: { sellers: 1, cents: 6400 },
    });
  });

  it('says the split, leaving out an empty method', () => {
    expect(fundingSplitText(fundingOf(lines))).toBe('$100.00 to 2 sellers on Venmo · $15.00 to 1 seller on PayPal');
    expect(fundingSplitText(fundingOf([line('VENMO', 'PENDING', 4000)]))).toBe('$40.00 to 1 seller on Venmo');
  });

  it('says whether the PayPal balance covers it, or how much short', () => {
    expect(balanceText(11500, 20000)).toEqual({ text: 'PayPal has $200.00 available: enough, before fees.', short: false });
    expect(balanceText(11500, 10000)).toEqual({ text: 'PayPal has $100.00 available: $15.00 short, before fees.', short: true });
    expect(balanceText(11500, null)).toBeNull();
  });
});
