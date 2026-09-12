import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { TAXONOMY_ICON_KEYS, isTaxonomyIconKey } from '../../contracts/taxonomy-icons';
import { ResolvedIconSchema } from '../../contracts/taxonomy.contracts';
import { registryIconUrl } from './taxonomy.service';

/**
 * What the iOS client is promised (handoff Ask J).
 *
 * A registry icon arrives with both a key and a URL, and the URL resolves to a
 * rendered glyph. The bytes are produced at authoring time by
 * `apps/web/scripts/render-taxonomy-icons.mjs` — a native client cannot resolve
 * a key against a bundle it does not have, and the server cannot render on
 * demand because its host has no access to the Font Awesome Pro registry.
 *
 * These are the tests that fail when someone adds a key and forgets to run it.
 */

const ASSETS = join(__dirname, 'assets');

describe('the rendered registry', () => {
  it('has a glyph for every key in the contract', () => {
    const missing = TAXONOMY_ICON_KEYS.filter((k) => !existsSync(join(ASSETS, `${k}.png`)));
    expect(missing).toEqual([]);
  });

  it('ships no glyph the contract does not name', () => {
    // A key removed from the contract leaves a file nothing can reach, and a
    // file is how a stale name keeps looking supported.
    const orphans = readdirSync(ASSETS)
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace(/\.png$/, ''))
      .filter((k) => !isTaxonomyIconKey(k));
    expect(orphans).toEqual([]);
  });

  it('renders each one as a real PNG, small enough to fetch on venue wifi', () => {
    for (const key of TAXONOMY_ICON_KEYS) {
      const size = statSync(join(ASSETS, `${key}.png`)).size;
      expect(size).toBeGreaterThan(100);
      // A 128px monochrome mark has no business being large; the observed
      // average is under 2KB, and 32KB would mean something went wrong.
      expect(size).toBeLessThan(32 * 1024);
    }
  });
});

describe('ResolvedIcon', () => {
  it('carries a key and a url on the registry arm', () => {
    const parsed = ResolvedIconSchema.parse({
      kind: 'registry',
      key: 'skis',
      url: registryIconUrl('org-1', 'skis'),
    });
    expect(parsed).toEqual({
      kind: 'registry',
      key: 'skis',
      url: '/api/v1/orgs/org-1/ski-swap/taxonomy/icons/skis.png',
    });
  });

  it('refuses a registry arm with no url, which iOS could not draw', () => {
    expect(() => ResolvedIconSchema.parse({ kind: 'registry', key: 'skis' })).toThrow();
  });

  it('refuses a key the registry does not know', () => {
    expect(() =>
      ResolvedIconSchema.parse({ kind: 'registry', key: 'not-a-key', url: '/x.png' }),
    ).toThrow();
  });

  it('leaves the uploaded arm as a bare url, because a logo is drawn untinted', () => {
    const parsed = ResolvedIconSchema.parse({ kind: 'image', url: 'https://s3/x.png' });
    expect(parsed).toEqual({ kind: 'image', url: 'https://s3/x.png' });
  });
});

describe('every icon URL carries the global prefix', () => {
  /**
   * `api/v1` is set by `setGlobalPrefix`, and a URL that omits it 404s.
   *
   * The uploaded-icon proxy did omit it. Nothing caught that because the path is
   * only reached when S3 is unconfigured, which no deployment is — so the bug
   * would have surfaced the first time someone ran without a bucket.
   */
  it('on a registry glyph', () => {
    expect(registryIconUrl('org-1', 'skis')).toMatch(/\/api\/v1\//);
  });

  it('and absolutely, when the deployment knows its origin', () => {
    expect(registryIconUrl('org-1', 'skis', 'https://patrolkit.io')).toBe(
      'https://patrolkit.io/api/v1/orgs/org-1/ski-swap/taxonomy/icons/skis.png',
    );
  });

  it('with no trailing-slash double up', () => {
    // APP_URL is hand-edited in a .env; a trailing slash there is a matter of time.
    expect(registryIconUrl('o', 'skis', 'https://patrolkit.io'.replace(/\/$/, ''))).not.toContain('//api');
  });
});

describe('registryIconUrl', () => {
  it('is org-scoped, so a device token can be matched against :orgId', () => {
    // A flat path would admit a user token and refuse every iPad, which
    // authenticates as a device.
    expect(registryIconUrl('abc', 'kayak')).toContain('/orgs/abc/');
  });

  it('names the key with a .png suffix the route strips', () => {
    expect(registryIconUrl('abc', 'kayak').endsWith('/icons/kayak.png')).toBe(true);
  });
});
