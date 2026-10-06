import { composeName } from './item-name';

describe('composeName', () => {
  it('puts the category last', () => {
    expect(composeName([{ text: 'Head' }, { text: '112cm' }], 'Skis')).toBe('Head 112cm Skis');
    expect(composeName([{ text: 'Head' }], 'Skis', ['blue'])).toBe('Head Skis blue');
  });
  it('in Other, ends with what the item is', () => {
    expect(composeName([{ text: 'Sled', freeEntry: true }, { text: 'Red' }], 'Other')).toBe('Red Sled');
    expect(composeName([{ text: 'Red' }], 'other')).toBe('Red other');
  });
  it('in Other, lets unmatched words say what it is', () => {
    expect(composeName([{ text: 'Red' }], 'Other', ['sled'])).toBe('Red sled');
    expect(composeName([{ text: 'Sled', freeEntry: true }, { text: 'Red' }], 'Other', ['big'])).toBe('Red Sled big');
  });
});
