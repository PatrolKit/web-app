import { describe, expect, it } from 'vitest';
import { isNewVersion, servedBuildId } from './newVersion';

describe('the new version banner', () => {
  it('shows for a different served build, never under the dev server or without an answer', () => {
    expect(isNewVersion('2026-10-11T13:00:00Z-aaa', '2026-10-11T14:00:00Z-bbb')).toBe(true);
    expect(isNewVersion('2026-10-11T13:00:00Z-aaa', '2026-10-11T13:00:00Z-aaa')).toBe(false);
    expect(isNewVersion('dev', '2026-10-11T14:00:00Z-bbb')).toBe(false);
    expect(isNewVersion('2026-10-11T13:00:00Z-aaa', null)).toBe(false);
  });

  it('reads the served build id, and treats any failure as no answer', async () => {
    const ok = (async () => new Response(JSON.stringify({ buildId: 'b2' }))) as typeof fetch;
    expect(await servedBuildId(ok)).toBe('b2');
    const html = (async () => new Response('<html>', { status: 200 })) as typeof fetch;
    expect(await servedBuildId(html)).toBeNull();
    const down = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await servedBuildId(down)).toBeNull();
    const missing = (async () => new Response('', { status: 404 })) as typeof fetch;
    expect(await servedBuildId(missing)).toBeNull();
  });
});
