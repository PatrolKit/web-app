import type { SwapResponse } from '../../lib/api.types';

export interface SwapForm {
  title: string;
  locationId: string;
  slug: string;
  allowLegacyCheckin: boolean;
  allowPrintCheckin: boolean;
  allowLegacyWeb: boolean;
  allowPrintWeb: boolean;
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
    // A new swap takes print tickets in both places, and no legacy tickets.
    allowLegacyCheckin: swap?.allowLegacyCheckin ?? false,
    allowPrintCheckin: swap?.allowPrintCheckin ?? true,
    allowLegacyWeb: swap?.allowLegacyWeb ?? false,
    allowPrintWeb: swap?.allowPrintWeb ?? true,
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
    'title', 'locationId', 'slug', 'allowLegacyCheckin', 'allowPrintCheckin', 'allowLegacyWeb', 'allowPrintWeb',
    'printLegacyHelperLabels', 'labelsPerItem', 'skuLookupEnabled', 'sellerLookupEnabled', 'sellerLoginEnabled',
  ] as const;
  return Object.fromEntries(keys.filter((k) => form[k] !== swap[k]).map((k) => [k, form[k]]));
}

/**
 * Why the ticket settings can't be saved, or null (Plan 34). Each place takes
 * legacy tickets, print tickets, or both: the server refuses a place with
 * neither, and the dialog says so first.
 */
export function ticketSettingsProblem(form: Pick<SwapForm, 'allowLegacyCheckin' | 'allowPrintCheckin' | 'allowLegacyWeb' | 'allowPrintWeb'>): string | null {
  if (!form.allowLegacyCheckin && !form.allowPrintCheckin) return 'Staff check-in needs legacy tickets, print tickets, or both.';
  if (!form.allowLegacyWeb && !form.allowPrintWeb) return 'The web needs legacy tickets, print tickets, or both.';
  return null;
}
