import { describe, expect, it } from 'vitest';
import { slugFrom } from './orgSlug';

describe('a slug from an org’s name', () => {
  it('is lowercase words joined by hyphens', () => {
    expect(slugFrom('Mt. Hood Ski Patrol')).toBe('mt-hood-ski-patrol');
    expect(slugFrom('  Blue Mountain / Whitetail  ')).toBe('blue-mountain-whitetail');
  });
  it('drops accents, says "and" for &', () => {
    expect(slugFrom('Côte & Crête')).toBe('cote-and-crete');
  });
  it('stays within 50 characters without a trailing hyphen', () => {
    const s = slugFrom('A Very Long Organization Name That Goes On And On Past The Limit');
    expect(s.length).toBeLessThanOrEqual(50);
    expect(s.endsWith('-')).toBe(false);
  });
  it('is empty for a name with nothing to keep', () => {
    expect(slugFrom('!!!')).toBe('');
  });
});
