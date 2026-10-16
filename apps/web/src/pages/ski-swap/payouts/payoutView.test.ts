import { describe, expect, it } from 'vitest';
import { batchStatusText, feeCents, feeRateText, fundingFor, sortSellers, statusView } from './payoutView';

const US = { flatCents: 25, bps: 0, capCents: 0 };

describe('PayPal fees (D17)', () => {
  it('charges a flat $0.25 a payment at the US Payouts API rate', () => {
    expect(feeCents(18720, US)).toBe(25);
    expect(fundingFor([18720, 2800, 80], US)).toEqual({ toSellers: 21600, fees: 75, total: 21675 });
  });

  it('adds a percentage up to its cap, for an account on other terms', () => {
    const rate = { flatCents: 0, bps: 200, capCents: 100 };
    expect(feeCents(2000, rate)).toBe(40);
    expect(feeCents(100_000, rate)).toBe(100);
  });

  it('says the rate in words', () => {
    expect(feeRateText(US)).toBe('$0.25 a payment');
    expect(feeRateText({ flatCents: 0, bps: 200, capCents: 100 })).toBe('2% of each payment, at most $1.00');
    expect(feeRateText({ flatCents: 0, bps: 0, capCents: 0 })).toBe('no fee');
  });
});

describe('sortSellers (D12)', () => {
  const rows = [
    { name: 'Marcus', netCents: 23600, items: 2 },
    { name: 'Dana', netCents: 18720, items: 3 },
    { name: 'Anna', netCents: 23600, items: 1 },
  ];

  it('sorts by name, by amount owed (highest first), or by items (most first), ties by name', () => {
    expect(sortSellers(rows, 'name').map((r) => r.name)).toEqual(['Anna', 'Dana', 'Marcus']);
    expect(sortSellers(rows, 'owed').map((r) => r.name)).toEqual(['Anna', 'Marcus', 'Dana']);
    expect(sortSellers(rows, 'items').map((r) => r.name)).toEqual(['Dana', 'Marcus', 'Anna']);
  });
});

describe('status words (D18, D19)', () => {
  it('says what a payment PayPal didn’t make means: pay them from another run', () => {
    expect(statusView('FAILED', 'PAYPAL').detail).toMatch(/another run/);
    expect(statusView('CANCELLED', 'PAYPAL').label).toBe('Cancelled');
  });

  it('calls a closed check run’s line Exported', () => {
    expect(statusView('EXPORTED', 'CHECK').label).toBe('Exported');
  });

  it('puts PayPal’s batch status in plain words', () => {
    expect(batchStatusText('SUCCESS')).toBe('Processed');
    expect(batchStatusText('DENIED')).toBe('Refused by PayPal');
  });
});
