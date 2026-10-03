import type { MemberResponse } from '../../lib/api.types';

/**
 * Whether a member matches the search box: every word of it against their name or
 * email, or its digits against their phone, however either was typed.
 */
export function matchesSearch(m: MemberResponse, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = [m.displayName, m.firstName, m.lastName, m.email].filter(Boolean).join(' ').toLowerCase();
  if (q.split(/\s+/).every((word) => text.includes(word))) return true;
  const digits = q.replace(/\D/g, '');
  return digits.length >= 3 && !!m.phone && m.phone.replace(/\D/g, '').includes(digits);
}
