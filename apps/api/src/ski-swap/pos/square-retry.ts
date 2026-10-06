import { SquareError } from 'square';

/** Waits after each refused try: 1, 2, 4, then 8 seconds (Plan 41 D8). */
const BACKOFF_MS = [1000, 2000, 4000, 8000];

/** Whether Square refused for its rate limit. */
export function isRateLimited(err: unknown): boolean {
  return err instanceof SquareError
    && (err.statusCode === 429 || err.errors.some((e) => e.code === 'RATE_LIMITED'));
}

/** Square's `Retry-After`, in milliseconds, when it sent one in seconds. */
function retryAfterMs(err: unknown): number | null {
  if (!(err instanceof SquareError)) return null;
  const raw = err.rawResponse?.headers?.get?.('retry-after');
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

/**
 * Runs a Square call, retrying while Square says it's over its rate limit.
 *
 * Five tries at most, honoring `Retry-After` when Square sends it, otherwise
 * backing off 1, 2, 4 and 8 seconds. Any other error is thrown at once: only
 * a 429 means "the same call, later, will work".
 */
export async function withRateLimitRetry<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (!isRateLimited(err) || attempt >= BACKOFF_MS.length) throw err;
      await sleep(retryAfterMs(err) ?? BACKOFF_MS[attempt]);
    }
  }
}
