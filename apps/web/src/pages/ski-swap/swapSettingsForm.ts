import type { SwapResponse } from '../../lib/api.types';

export interface SwapForm {
  title: string;
  locationId: string;
  slug: string;
  legacyTicketsEnabled: boolean;
  legacyTicketsOnly: boolean;
  webLegacyTicketsOnly: boolean;
  printLegacyHelperLabels: boolean;
  labelsPerItem: number;
  skuLookupEnabled: boolean;
  sellerLookupEnabled: boolean;
  sellerLoginEnabled: boolean;
}

export function formFor(swap: SwapResponse | null): SwapForm {
  return {
    title: swap?.title ?? '',
    locationId: swap?.locationId ?? '',
    slug: swap?.slug ?? '',
    legacyTicketsEnabled: swap?.legacyTicketsEnabled ?? false,
    legacyTicketsOnly: swap?.legacyTicketsOnly ?? false,
    webLegacyTicketsOnly: swap?.webLegacyTicketsOnly ?? false,
    printLegacyHelperLabels: swap?.printLegacyHelperLabels ?? false,
    labelsPerItem: swap?.labelsPerItem ?? 1,
    skuLookupEnabled: swap?.skuLookupEnabled ?? false,
    sellerLookupEnabled: swap?.sellerLookupEnabled ?? false,
    sellerLoginEnabled: swap?.sellerLoginEnabled ?? false,
  };
}

/** Only what changed, so a save never rewrites a setting nobody touched. */
export function changes(form: SwapForm, swap: SwapResponse) {
  const keys = [
    'title', 'locationId', 'slug', 'legacyTicketsEnabled', 'legacyTicketsOnly', 'webLegacyTicketsOnly',
    'printLegacyHelperLabels', 'labelsPerItem', 'skuLookupEnabled', 'sellerLookupEnabled', 'sellerLoginEnabled',
  ] as const;
  return Object.fromEntries(keys.filter((k) => form[k] !== swap[k]).map((k) => [k, form[k]]));
}
