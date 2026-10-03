import { describe, expect, it } from 'vitest';
import type { MemberResponse } from '../../lib/api.types';
import { matchesSearch } from './memberSearch';

const dana = {
  displayName: 'Dana Reyes', firstName: 'Dana', lastName: 'Reyes',
  email: 'dana.reyes@example.com', phone: '+1 (802) 555-0142',
} as MemberResponse;

describe('the members search box', () => {
  it('matches everyone when empty', () => {
    expect(matchesSearch(dana, '  ')).toBe(true);
  });

  it('matches a name, in any order and any case', () => {
    expect(matchesSearch(dana, 'reyes')).toBe(true);
    expect(matchesSearch(dana, 'Reyes Dana')).toBe(true);
    expect(matchesSearch(dana, 'dana smith')).toBe(false);
  });

  it('matches part of an email', () => {
    expect(matchesSearch(dana, 'example.com')).toBe(true);
  });

  it('matches a phone however it was typed', () => {
    expect(matchesSearch(dana, '555-0142')).toBe(true);
    expect(matchesSearch(dana, '8025550142')).toBe(true);
    expect(matchesSearch(dana, '999')).toBe(false);
  });

  it('ignores too few digits to mean anything', () => {
    expect(matchesSearch(dana, '80')).toBe(false);
  });
});
