const STOP_WORDS = new Set(['a', 'the', 'and', 'of', 'for', 'in', 'on', 'at', 'to', 'by']);

/**
 * Codes that namespace a SKU — one per minting endpoint, drawn from a single
 * per-org pool shared by check-in stations and check-in devices, so the
 * character in a SKU always identifies exactly one of them.
 *
 * `I`, `O`, `0` and `1` are excluded: the code prints as text beneath the
 * barcode and gets read aloud across a counter, where those four are the pairs
 * people confuse. That leaves 32 codes per org.
 */
export const SKU_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Reserved for SKUs minted by the server itself — staff entering items in the
 * web UI, with no station or device involved. Never allocatable, and never
 * printed: `formatSku` omits the segment entirely for these.
 */
export const SERVER_SKU_CODE = '*';

/**
 * Derives a short uppercase prefix from a swap title, e.g. "Ski Swap 2026" → "SS26".
 * Result contains only [A-Z0-9], max 6 characters.
 */
export function deriveSkuPrefix(title: string): string {
  const yearMatch = title.match(/\b(\d{4})\b/);
  const yearSuffix = yearMatch ? yearMatch[1].slice(-2) : '';

  const letters = title
    .split(/\s+/)
    .filter((w) => !/^\d+$/.test(w) && !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter((w) => w.length > 0)
    .map((w) => w[0].toUpperCase())
    .join('');

  return (letters + yearSuffix).replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'SK';
}

/** What a swap slug may be: lowercase letters, digits and hyphens (Plan 33). */
export const SWAP_SLUG_PATTERN = /^[a-z0-9-]{1,40}$/;

/**
 * A swap's slug, by the same derivation as its SKU prefix, lowercased:
 * "Ski Swap 2026" → "ss26". One derivation, so the two read alike.
 */
export function deriveSwapSlug(title: string): string {
  return deriveSkuPrefix(title).toLowerCase();
}

/**
 * Formats a SKU. With a station or device code the shape is `PREFIX-C-NNNN`;
 * without one — a staff-entered item — it stays `PREFIX-NNNN`.
 *
 * The result is the Code128-B payload on the tag, and 13 characters is the most
 * that fits the label at a scannable module width: 6 prefix + 1 code + 4 counter
 * + 2 separators. Nothing here may grow without shrinking something else.
 */
export function formatSku(prefix: string, code: string | null, counter: number): string {
  const n = String(counter).padStart(4, '0');
  return code && code !== SERVER_SKU_CODE ? `${prefix}-${code}-${n}` : `${prefix}-${n}`;
}

/**
 * The station or device code inside a SKU, or null when it has none.
 *
 * The inverse of `formatSku`: `SS26-A-0001` is `A`, while `SS26-0001` (entered on
 * the web) and a bare legacy ticket number carry no code. It is what puts the
 * station's letter on a tag (Plan 27), read from the number itself so a reprint,
 * or a tag from any bridge or iPad, shows the same letter as the first one.
 */
export function stationCodeOf(sku: string): string | null {
  const match = /^[A-Z0-9]{1,6}-([A-Z0-9])-\d{4,}$/.exec(sku);
  return match && SKU_CODE_ALPHABET.includes(match[1]) ? match[1] : null;
}

/** The widest SKU the barcode can carry at 2 dots per module on a 400-dot head. */
export const MAX_SKU_LENGTH = 13;
