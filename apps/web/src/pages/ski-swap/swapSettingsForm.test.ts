import { describe, expect, it } from 'vitest';
import type { SwapResponse } from '../../lib/api.types';
import { changes, formFor, ticketSettingsProblem } from './swapSettingsForm';

const swap = {
  id: 'swap-1', title: 'Ski Swap 2026', locationId: 'loc', slug: 'ss26', allowLegacyCheckin: false,
  allowPrintCheckin: true, allowLegacyWeb: false, allowPrintWeb: true, printLegacyHelperLabels: false, labelsPerItem: 1,
  skuLookupEnabled: false, sellerLookupEnabled: false, sellerLoginEnabled: false,
} as SwapResponse;

describe('the settings dialog’s one save', () => {
  it('sends nothing that wasn’t changed', () => {
    expect(changes(formFor(swap), swap)).toEqual({});
  });

  it('sends only what changed, across tabs', () => {
    const form = { ...formFor(swap), slug: 'spring', skuLookupEnabled: true, labelsPerItem: 2 };
    expect(changes(form, swap)).toEqual({ slug: 'spring', skuLookupEnabled: true, labelsPerItem: 2 });
  });

  it('starts a new swap with every status switch off', () => {
    expect(formFor(null)).toMatchObject({ skuLookupEnabled: false, sellerLookupEnabled: false, sellerLoginEnabled: false });
  });
});

describe('the ticket settings (Plan 34)', () => {
  it('start a new swap on print tickets in both places, and no legacy tickets', () => {
    expect(formFor(null)).toMatchObject({ allowLegacyCheckin: false, allowLegacyWeb: false, allowPrintCheckin: true, allowPrintWeb: true });
  });

  it('need a way in at each place', () => {
    const form = formFor(swap);
    expect(ticketSettingsProblem(form)).toBeNull();
    expect(ticketSettingsProblem({ ...form, allowPrintCheckin: false })).toMatch(/Staff check-in needs/);
    expect(ticketSettingsProblem({ ...form, allowPrintWeb: false })).toMatch(/The web needs/);
    expect(ticketSettingsProblem({ ...form, allowPrintCheckin: false, allowLegacyCheckin: true })).toBeNull();
  });
});
