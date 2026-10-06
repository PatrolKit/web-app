import { describe, expect, it } from 'vitest';
import { isActiveNow, timeAgo } from './timeAgo';

const now = Date.parse('2026-10-06T12:00:00Z');
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

describe('time ago', () => {
  it('says it in the largest sensible unit', () => {
    expect(timeAgo(null, now)).toBeNull();
    expect(timeAgo(at(30_000), now)).toBe('just now');
    expect(timeAgo(at(5 * 60_000), now)).toBe('5 min ago');
    expect(timeAgo(at(3 * 3600_000), now)).toBe('3 h ago');
    expect(timeAgo(at(3 * 86400_000), now)).toBe('3 d ago');
  });
  it('counts a session renewed in the last 20 minutes as active now', () => {
    expect(isActiveNow(at(15 * 60_000), now)).toBe(true);
    expect(isActiveNow(at(25 * 60_000), now)).toBe(false);
    expect(isActiveNow(null, now)).toBe(false);
  });
});
