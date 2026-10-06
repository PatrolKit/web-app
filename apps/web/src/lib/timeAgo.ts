/**
 * "just now", "5 min ago", "3 h ago", "2 d ago", for last-seen and
 * last-active columns. `now` is a parameter so tests can fix it.
 */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Within this, a member counts as active now: a session renews every 15 minutes of use. */
export const ACTIVE_NOW_MS = 20 * 60 * 1000;

export function isActiveNow(iso: string | null | undefined, now = Date.now()): boolean {
  return !!iso && now - new Date(iso).getTime() < ACTIVE_NOW_MS;
}
