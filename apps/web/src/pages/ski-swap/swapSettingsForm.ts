import type { ReceiptLinkChoice, ReceiptMode, ReceiptPaperSize, SwapResponse } from '../../lib/api.types';

export interface SwapForm {
  title: string;
  locationId: string;
  slug: string;
  timeZone: string;
  allowLegacyCheckin: boolean;
  allowPrintCheckin: boolean;
  allowLegacyWeb: boolean;
  allowPrintWeb: boolean;
  printLegacyHelperLabels: boolean;
  labelsPerItem: number;
  skuLookupEnabled: boolean;
  sellerLookupEnabled: boolean;
  sellerLoginEnabled: boolean;
  receiptMode: ReceiptMode;
  receiptShowSku: boolean;
  receiptShowName: boolean;
  receiptShowPrice: boolean;
  receiptLink: ReceiptLinkChoice;
  receiptPrintEnabled: boolean;
  receiptPaperSize: ReceiptPaperSize;
  receiptFinePrintEnabled: boolean;
  receiptFinePrint: string | null;
}

export function formFor(swap: SwapResponse | null): SwapForm {
  return {
    title: swap?.title ?? '',
    locationId: swap?.locationId ?? '',
    slug: swap?.slug ?? '',
    // A new swap is wherever the person making it is, as a guess they can change.
    timeZone: swap?.timeZone ?? browserTimeZone(),
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
    // A new swap: itemized with every column, no link, printing on 62 × 100,
    // no fine print (Plan 36 D9).
    receiptMode: swap?.receiptMode ?? 'ITEMIZED',
    receiptShowSku: swap?.receiptShowSku ?? true,
    receiptShowName: swap?.receiptShowName ?? true,
    receiptShowPrice: swap?.receiptShowPrice ?? true,
    receiptLink: swap?.receiptLink ?? 'NONE',
    receiptPrintEnabled: swap?.receiptPrintEnabled ?? true,
    receiptPaperSize: swap?.receiptPaperSize ?? '62x100',
    receiptFinePrintEnabled: swap?.receiptFinePrintEnabled ?? false,
    receiptFinePrint: swap?.receiptFinePrint ?? null,
  };
}

/** Only what changed, so a save never rewrites a setting nobody touched. */
export function changes(form: SwapForm, swap: SwapResponse) {
  const keys = [
    'title', 'locationId', 'slug', 'allowLegacyCheckin', 'allowPrintCheckin', 'allowLegacyWeb', 'allowPrintWeb',
    'printLegacyHelperLabels', 'labelsPerItem', 'skuLookupEnabled', 'sellerLookupEnabled', 'sellerLoginEnabled', 'timeZone',
    'receiptMode', 'receiptShowSku', 'receiptShowName', 'receiptShowPrice', 'receiptLink',
    'receiptPrintEnabled', 'receiptPaperSize', 'receiptFinePrintEnabled', 'receiptFinePrint',
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

/** Fine print's limit, in characters of text (Plan 36 D13). */
export const FINE_PRINT_MAX_CHARS = 2000;

/** The text a reader sees in fine print, counted as the server counts it: tags dropped, spaces collapsed. */
export function finePrintText(html: string | null): string {
  return (html ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The status pages a receipt can link to: the ones switched on, in the dialog as it stands. */
export function receiptLinkOptions(form: Pick<SwapForm, 'skuLookupEnabled' | 'sellerLookupEnabled' | 'sellerLoginEnabled'>) {
  return [
    ...(form.skuLookupEnabled ? [{ value: 'SKU_LOOKUP' as const, label: 'Unauthenticated SKU Lookup' }] : []),
    ...(form.sellerLookupEnabled ? [{ value: 'SELLER_STATUS' as const, label: 'Unauthenticated Seller Status' }] : []),
    ...(form.sellerLoginEnabled ? [{ value: 'SELLER_LOGIN' as const, label: 'Authenticated Seller Status' }] : []),
  ];
}

/**
 * Why the receipt settings can't be saved, or null (Plan 36): the same rules
 * the server keeps, said before Save.
 */
export function receiptSettingsProblem(form: SwapForm): string | null {
  if (form.receiptMode === 'STATUS_ONLY' && form.receiptLink === 'NONE') {
    return 'A status-page-only receipt needs a status page to link to.';
  }
  if (form.receiptMode === 'ITEMIZED' && !form.receiptShowSku && !form.receiptShowName) {
    return 'An itemized receipt needs each item’s SKU or description, or both.';
  }
  if (form.receiptMode !== 'NONE' && form.receiptFinePrintEnabled) {
    const text = finePrintText(form.receiptFinePrint);
    if (!text) return 'Add some fine print, or turn it off.';
    if (text.length > FINE_PRINT_MAX_CHARS) return `Fine print is limited to ${FINE_PRINT_MAX_CHARS.toLocaleString('en-US')} characters.`;
  }
  return null;
}

/** The zone a swap is in when nobody has said: the US ones by name, first. */
export const US_TIME_ZONES = [
  { value: 'America/New_York', label: 'Eastern' },
  { value: 'America/Chicago', label: 'Central' },
  { value: 'America/Denver', label: 'Mountain' },
  { value: 'America/Phoenix', label: 'Arizona, no daylight saving' },
  { value: 'America/Los_Angeles', label: 'Pacific' },
  { value: 'America/Anchorage', label: 'Alaska' },
  { value: 'Pacific/Honolulu', label: 'Hawaii' },
] as const;

const DEFAULT_TIME_ZONE = 'America/New_York';

/** This browser's zone, or the default where it can't say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Every other zone this browser knows, for a swap outside the US. */
export function otherTimeZones(): string[] {
  const us = new Set<string>(US_TIME_ZONES.map((z) => z.value));
  try {
    // ES2022, which this build's lib predates; every browser we support has it.
    const all = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return all.filter((z) => !us.has(z));
  } catch {
    return [];
  }
}
