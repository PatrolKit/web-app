import { payoutProgress, type ProgressLine } from './payout-progress';

const line = (sellerId: string, status: string, netCents: number | null = null, active = true): ProgressLine =>
  ({ sellerId, status, netCents, activeKey: active ? `k-${sellerId}` : null });

describe('payoutProgress', () => {
  it('counts paid, in a run, and not in one yet, by seller', () => {
    const owed = [
      { sellerId: 'a', netCents: 1600, donated: false },
      { sellerId: 'b', netCents: 2000, donated: false },
      { sellerId: 'c', netCents: 3000, donated: false },
      { sellerId: 'd', netCents: 500, donated: false },
    ];
    const lines = [line('a', 'SENT', 1600), line('b', 'EXPORTED', 2000), line('c', 'APPROVED', 3000)];
    expect(payoutProgress(owed, lines)).toEqual({ sellers: 4, paid: 2, inRun: 1, paidCents: 3600, owedCents: 7100 });
  });

  it('pays the amount paid, not what they owe now', () => {
    expect(payoutProgress([{ sellerId: 'a', netCents: 2500, donated: false }], [line('a', 'SENT', 2000)]))
      .toMatchObject({ paid: 1, paidCents: 2000, owedCents: 2000 });
  });

  it('a payment PayPal did not make leaves them owed and out of a run', () => {
    const p = payoutProgress([{ sellerId: 'a', netCents: 1000, donated: false }], [line('a', 'FAILED', 1000, false)]);
    expect(p).toEqual({ sellers: 1, paid: 0, inRun: 0, paidCents: 0, owedCents: 1000 });
  });

  it('a seller paid and since owed nothing still counts as paid', () => {
    expect(payoutProgress([], [line('a', 'SENT', 1200)])).toMatchObject({ sellers: 1, paid: 1, paidCents: 1200 });
  });

  it('leaves out donations and sellers owed nothing', () => {
    const owed = [{ sellerId: 'a', netCents: 900, donated: true }, { sellerId: 'b', netCents: 0, donated: false }];
    expect(payoutProgress(owed, [line('b', 'PENDING')]).sellers).toBe(0);
  });
});
