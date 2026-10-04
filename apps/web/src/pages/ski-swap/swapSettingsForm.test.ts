import { describe, expect, it } from 'vitest';
import type { SwapResponse } from '../../lib/api.types';
import { changes, formFor } from './swapSettingsForm';

const swap = {
  id: 'swap-1', title: 'Ski Swap 2026', locationId: 'loc', slug: 'ss26', legacyTicketsEnabled: false,
  legacyTicketsOnly: false, webLegacyTicketsOnly: false, printLegacyHelperLabels: false, labelsPerItem: 1,
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
