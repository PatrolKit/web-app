import { describe, expect, it } from 'vitest';
import { batchStatusText, feeCents, feeRateText, fundingFor, namesText, percentText, runOutcome, runPaidText, runStage, sortSellers, statusView } from './payoutView';

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

describe('a share as a percentage', () => {
  it('rounds to a tenth, and drops a trailing zero', () => {
    expect([percentText(0.2), percentText(0.1234), percentText(-0.045), percentText(0)]).toEqual(['20%', '12.3%', '−4.5%', '0%']);
  });
});

describe('how a closed run ended (D15, D19)', () => {
  const waiting = (name: string) => ({ name, unresolved: true });
  const moved = (name: string) => ({ name, unresolved: false });
  it('a PayPal run that paid everyone is paid, with the amount', () => {
    expect(runOutcome('PAYPAL', 1, [], 1600)).toEqual({ label: 'Paid', tone: 'green', text: 'Everyone was paid: 1 payment, $16.00.' });
  });
  it('someone not paid and not in another run is a warning that names them', () => {
    const o = runOutcome('PAYPAL', 3, [waiting('Dana Reyes')]);
    expect([o.label, o.tone]).toEqual(['Partly paid', 'amber']);
    expect(o.text).toBe('3 of 4 payments paid. Not paid, and not in another run: Dana Reyes. Add them to another run to pay them.');
  });
  it('nobody paid, and nobody in another run, is not paid', () => {
    expect(runOutcome('PAYPAL', 0, [waiting('A'), waiting('B')])).toMatchObject({ label: 'Not paid', tone: 'red' });
  });
  it('everyone not paid being in another run is no warning: nothing is left to do', () => {
    expect(runOutcome('PAYPAL', 49, [moved('Jared Fleet')], 1600)).toEqual({
      label: '49 of 50 paid', tone: 'gray', text: '49 of 50 payments paid, $16.00. Jared Fleet is in another run. Nothing’s left to do here.',
    });
  });
  it('a warning still says who is in another run', () => {
    expect(runOutcome('PAYPAL', 2, [waiting('A'), moved('B'), moved('C')]).text).toBe(
      '2 of 5 payments paid. Not paid, and not in another run: A. Add them to another run to pay them. B and C are in another run.',
    );
  });
  it('a closed check run is exported', () => {
    expect(runOutcome('CHECK', 2, [], 5000)).toEqual({ label: 'Exported', tone: 'green', text: '2 checks, $50.00, to write from the spreadsheet.' });
  });
  it('names read as a list, and a long one is cut short', () => {
    expect([namesText(['A']), namesText(['A', 'B']), namesText(['A', 'B', 'C'])]).toEqual(['A', 'A and B', 'A, B and C']);
    expect(namesText(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('A, B, C, D, E and 2 more');
  });
});

describe('the runs list', () => {
  const run = { kind: 'PAYPAL' as const, status: 'OPEN' as const, sent: false, lineCount: 50, paidCount: 0 };
  it('an open run is open until sent, then processing until closed', () => {
    expect(runStage(run)).toBe('Open');
    expect(runStage({ ...run, sent: true })).toBe('Processing');
    expect(runStage({ ...run, sent: true, status: 'CLOSED' })).toBe('Closed');
    expect(runStage({ ...run, kind: 'CHECK', status: 'CLOSED' })).toBe('Closed');
  });
  it('says nothing about paying before a run is sent', () => {
    expect(runPaidText(run)).toEqual({ text: '—', tone: 'gray' });
    expect(runPaidText({ ...run, kind: 'CHECK' })).toEqual({ text: '—', tone: 'gray' });
  });
  it('counts who was paid, and says Paid when everyone was', () => {
    expect(runPaidText({ ...run, sent: true, paidCount: 49 })).toEqual({ text: '49 of 50', tone: 'gray' });
    expect(runPaidText({ ...run, sent: true, status: 'CLOSED', paidCount: 50 })).toEqual({ text: 'Paid', tone: 'green' });
  });
  it('a closed check run is exported', () => {
    expect(runPaidText({ ...run, kind: 'CHECK', status: 'CLOSED', paidCount: 50 })).toEqual({ text: 'Exported', tone: 'green' });
  });
});
