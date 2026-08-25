/**
 * Person-shaped helpers shared by every module that renders or matches a human.
 *
 * All identity lives on `User`; these functions define how its fields are
 * normalised for matching and how they are collapsed for display.
 */

/** Minimal shape needed to render a person's name. */
export interface NameParts {
  firstName: string | null;
  lastName: string | null;
  email?: string | null;
  phone?: string | null;
}

function toTitleCase(s: string): string {
  return s.trim().replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Title-cases a supplied name part, or returns null for blank input. */
export function normalizeNamePart(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed ? toTitleCase(trimmed) : null;
}

/**
 * Splits a single free-text name into parts. Used only where a caller supplies
 * one string (CSV imports, legacy payloads) — everything else carries the parts
 * separately. The last whitespace-delimited token becomes the surname.
 */
export function splitName(raw: string): { firstName: string | null; lastName: string | null } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: normalizeNamePart(parts[0]), lastName: null };
  return {
    firstName: normalizeNamePart(parts.slice(0, -1).join(' ')),
    lastName: normalizeNamePart(parts[parts.length - 1]),
  };
}

/**
 * The one place a person becomes a display string. Business name wins when the
 * caller has a seller profile in hand, then the human's name, then whatever
 * contact identifies them. Never returns an empty string.
 */
export function displayName(user: NameParts, businessName?: string | null): string {
  if (businessName?.trim()) return businessName.trim();
  const human = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  if (human) return human;
  return user.email?.trim() || user.phone?.trim() || 'Unnamed';
}

/** Case-folded for matching. Email comparison is case-insensitive in practice. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed || null;
}

/**
 * E.164, assuming NANP when no country code is given — every number in the
 * product today is US or Canadian. Returns null when the input cannot be a
 * phone number, so callers store a null claim rather than a garbage one.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 8 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/**
 * Applied identically on the device before comparison. Leading zeros are
 * significant — some divisions issue them — so only non-alphanumerics are
 * stripped.
 */
export function normalizeNspId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return normalized || null;
}
