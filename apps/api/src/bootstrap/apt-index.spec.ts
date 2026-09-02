import { parsePackagesIndex } from './apt-index.service';

/**
 * Reading a `Packages` file.
 *
 * The two cases that matter are both consequences of `pool/` being append-only
 * (APT_REPO_PLAN §7a): a repository carries every version it has ever
 * published, so the index has several stanzas per package, and the newest must
 * win rather than the last one parsed.
 */
describe('parsePackagesIndex', () => {
  it('reads name and version out of stanzas', () => {
    const index = [
      'Package: patrolkit-signage',
      'Version: 1.4.2',
      'Architecture: arm64',
      '',
      'Package: patrolkit-agent',
      'Version: 0.9.0',
      '',
    ].join('\n');

    expect(parsePackagesIndex(index)).toEqual(
      new Map([
        ['patrolkit-signage', '1.4.2'],
        ['patrolkit-agent', '0.9.0'],
      ]),
    );
  });

  it('keeps the newest of several versions, not the last seen', () => {
    const index = [
      'Package: app',
      'Version: 1.10.0',
      '',
      'Package: app',
      'Version: 1.9.0',
      '',
    ].join('\n');

    expect(parsePackagesIndex(index).get('app')).toBe('1.10.0');
  });

  it('ignores continuation lines, so a multi-line Description cannot be read as a field', () => {
    const index = [
      'Package: app',
      'Description: A thing',
      ' Version: 9.9.9 mentioned in prose',
      'Version: 1.0.0',
      '',
    ].join('\n');

    expect(parsePackagesIndex(index).get('app')).toBe('1.0.0');
  });

  it('handles a final stanza with no trailing blank line', () => {
    expect(parsePackagesIndex('Package: app\nVersion: 1.0.0').get('app')).toBe('1.0.0');
  });

  it('drops a stanza that names no version', () => {
    expect(parsePackagesIndex('Package: app\nArchitecture: arm64\n').size).toBe(0);
  });
});
