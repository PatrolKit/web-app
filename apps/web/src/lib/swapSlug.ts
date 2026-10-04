/**
 * A swap's slug, as the server derives it (Plan 33): the SKU prefix's
 * derivation, lowercased. "Ski Swap 2026" → "ss26". Mirrors `deriveSkuPrefix`
 * and `deriveSwapSlug` in apps/api/src/ski-swap/sku.util.ts, so the dialog's
 * preview is what the server would make. The server still makes it unique.
 */
const STOP_WORDS = new Set(['a', 'the', 'and', 'of', 'for', 'in', 'on', 'at', 'to', 'by']);

export function deriveSwapSlug(title: string): string {
  const yearMatch = title.match(/\b(\d{4})\b/);
  const yearSuffix = yearMatch ? yearMatch[1].slice(-2) : '';
  const letters = title
    .split(/\s+/)
    .filter((w) => !/^\d+$/.test(w) && !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase())
    .join('');
  return ((letters + yearSuffix).replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SK').toLowerCase();
}

/** What a slug may be: lowercase letters, digits and hyphens, up to 40. */
export const SWAP_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/** The SKU lookup page's address. */
export function swapStatusUrl(sellerSiteUrl: string, orgSlug: string, swapSlug: string): string {
  return `${sellerSiteUrl.replace(/\/$/, '')}/${orgSlug}/${swapSlug}/status`;
}
