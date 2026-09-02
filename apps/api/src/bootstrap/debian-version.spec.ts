import { compareDebianVersions, newestVersion, parseDebianVersion } from './debian-version';

/**
 * The comparison the fleet's version pinning rests on.
 *
 * Table-driven because there is no natural coverage from above: every case here
 * is a pair of strings that a `sort()` would order wrongly, and getting one
 * wrong pins devices backwards rather than failing anything.
 */

describe('parseDebianVersion', () => {
  it.each([
    ['1.2.3', { epoch: 0, upstream: '1.2.3', revision: '' }],
    ['1:1.2.3', { epoch: 1, upstream: '1.2.3', revision: '' }],
    ['1.2.3-2', { epoch: 0, upstream: '1.2.3', revision: '2' }],
    ['2:1.2.3-4', { epoch: 2, upstream: '1.2.3', revision: '4' }],
    // The *last* hyphen splits: an upstream version may contain hyphens, a
    // revision may not.
    ['1.2-beta-3', { epoch: 0, upstream: '1.2-beta', revision: '3' }],
    // A colon that is not an epoch is part of the version, not a separator.
    ['1.2:3', { epoch: 0, upstream: '1.2:3', revision: '' }],
  ])('parses %s', (input, expected) => {
    expect(parseDebianVersion(input)).toEqual(expected);
  });
});

describe('compareDebianVersions', () => {
  // Each pair is [older, newer].
  it.each([
    // The one a string sort gets wrong, and the reason this file exists.
    ['1.9.0', '1.10.0'],
    ['1.0.9', '1.0.10'],
    // Epoch beats everything, including a much larger upstream version.
    ['2.0', '1:0.1'],
    ['1:5.0', '2:1.0'],
    // Revisions decide ties.
    ['1.2.3-1', '1.2.3-2'],
    ['1.2.3', '1.2.3-1'],
    // `~` sorts before everything, including the end of the string. This is
    // what makes a release candidate older than the release.
    ['1.0~rc1', '1.0'],
    ['1.0~alpha', '1.0~beta'],
    ['1.0~~', '1.0~'],
    // Letters sort before every other non-digit character.
    ['1.0a', '1.0+b'],
    // Longer digit runs are larger numbers regardless of first digit.
    ['1.9', '1.10'],
    ['1.0-1', '1.0-10'],
  ])('%s is older than %s', (older, newer) => {
    expect(compareDebianVersions(older, newer)).toBeLessThan(0);
    expect(compareDebianVersions(newer, older)).toBeGreaterThan(0);
  });

  it.each([
    ['1.2.3', '1.2.3'],
    // Leading zeros carry no value.
    ['1.007', '1.7'],
    ['1.0-01', '1.0-1'],
    // An absent epoch is epoch zero.
    ['0:1.2.3', '1.2.3'],
    // An absent revision is an empty revision.
    ['1.2.3', '1.2.3'],
  ])('%s equals %s', (a, b) => {
    expect(compareDebianVersions(a, b)).toBe(0);
  });

  it('orders a realistic release history', () => {
    const shuffled = ['1.10.0', '1.2.0', '1.0.0~rc1', '1.9.0', '1.0.0', '2:0.1.0', '1.2.0-2'];
    const sorted = [...shuffled].sort(compareDebianVersions);
    expect(sorted).toEqual([
      '1.0.0~rc1', '1.0.0', '1.2.0', '1.2.0-2', '1.9.0', '1.10.0', '2:0.1.0',
    ]);
  });
});

describe('newestVersion', () => {
  it('is null for nothing', () => {
    expect(newestVersion([])).toBeNull();
  });

  it('picks the newest rather than the last', () => {
    expect(newestVersion(['1.10.0', '1.9.0', '1.2.0'])).toBe('1.10.0');
  });
});
