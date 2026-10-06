import { SquareError } from 'square';
import { withRateLimitRetry } from './square-retry';

const limited = (retryAfter?: string) => new SquareError({
  statusCode: 429,
  body: { errors: [{ category: 'RATE_LIMIT_ERROR', code: 'RATE_LIMITED' }] },
  rawResponse: { headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}) } as never,
});

describe('retrying Square on its rate limit (Plan 41 D8)', () => {
  it('retries a 429, backing off 1, 2, 4 and 8 s', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await withRateLimitRetry(async () => {
      if (++calls < 4) throw limited();
      return 'ok';
    }, async (ms) => { waits.push(ms); });
    expect(out).toBe('ok');
    expect(waits).toEqual([1000, 2000, 4000]);
  });

  it('honors Retry-After', async () => {
    const waits: number[] = [];
    let calls = 0;
    await withRateLimitRetry(async () => { if (++calls < 2) throw limited('3'); return 1; }, async (ms) => { waits.push(ms); });
    expect(waits).toEqual([3000]);
  });

  it('gives up after five tries', async () => {
    let calls = 0;
    await expect(withRateLimitRetry(async () => { calls++; throw limited(); }, async () => undefined)).rejects.toBeInstanceOf(SquareError);
    expect(calls).toBe(5);
  });

  it('never retries anything else', async () => {
    let calls = 0;
    await expect(withRateLimitRetry(async () => { calls++; throw new Error('boom'); }, async () => undefined)).rejects.toThrow('boom');
    expect(calls).toBe(1);
  });
});
