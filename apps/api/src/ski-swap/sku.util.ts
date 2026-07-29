const STOP_WORDS = new Set(['a', 'the', 'and', 'of', 'for', 'in', 'on', 'at', 'to', 'by']);

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

/** Formats a counter into a full SKU string, e.g. ("SS26", 42) → "SS26-0042". */
export function formatSku(prefix: string, counter: number): string {
  return `${prefix}-${String(counter).padStart(4, '0')}`;
}
