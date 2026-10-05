import type { ItemResponse } from '../../lib/api.types';

/**
 * Scan Ticket's list, kept apart from the popover so it can be tested: each
 * scan is a lookup, newest first, that ends found, missing, or failed.
 */

export interface Lookup {
  /** Unique per scan, so the same tag scanned twice is two rows. */
  key: number;
  code: string;
  state: 'looking' | 'found' | 'missing' | 'failed';
  item?: ItemResponse;
  error?: string;
}

/** A scan or a typed code, trimmed; blank is nothing. It goes in first, looking. */
export function looked(lookups: Lookup[], raw: string, key: number): { lookups: Lookup[]; code: string | null } {
  const code = raw.trim();
  if (!code) return { lookups, code: null };
  return { lookups: [{ key, code, state: 'looking' }, ...lookups], code };
}

/** How one lookup ended. */
export function settled(lookups: Lookup[], key: number, end: Pick<Lookup, 'state' | 'item' | 'error'>): Lookup[] {
  return lookups.map((l) => (l.key === key ? { ...l, ...end } : l));
}
