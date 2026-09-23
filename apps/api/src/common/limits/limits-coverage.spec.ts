import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { LIMITS } from './limits';

/**
 * Every limit comes from the registry (Plan 26 §11).
 *
 * The Server health page lists `LIMITS`. A limit written anywhere else is one
 * the page does not know about, and a number the page shows that the server
 * does not use.
 */

const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('the limit registry', () => {
  const files = sources(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }));

  it('is the only place a throttle is configured', () => {
    // `SkipThrottle` exempts a route and carries no number, so it stays.
    const offenders = files.filter((f) => /(^|[^A-Za-z])Throttle\s*\(/.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('is read by every check that counts sends', () => {
    const expectations: Record<string, string[]> = {
      'auth/contact-challenge.service.ts': ["LIMITS['codes.perDestination']", "LIMITS['codes.perDestinationDaily']"],
      'ski-swap/receipt.service.ts': ["LIMITS['receipts.perDestination']"],
      'sms/sms.service.ts': ["LIMITS['sms.site']"],
    };
    for (const [path, needles] of Object.entries(expectations)) {
      const text = files.find((f) => f.path === path)!.text;
      for (const needle of needles) expect({ path, found: text.includes(needle) }).toEqual({ path, found: true });
    }
  });

  it('has every limit it lists in use somewhere', () => {
    const everything = files.filter((f) => !f.path.startsWith('common/limits/limits.ts')).map((f) => f.text).join('\n');
    const unused = Object.keys(LIMITS).filter((id) => !everything.includes(`'${id}'`));
    expect(unused).toEqual([]);
  });
});
