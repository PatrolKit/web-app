import { bootSizeText, composeName, usBootSize } from './item-name';

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

describe('US boot sizes, as agreed with the patrol', () => {
  it('men’s is MP − 18, women’s MP − 17', () => {
    expect([22, 23, 24, 25, 26.5, 28, 30].map((mp) => usBootSize(mp, 'Mens'))).toEqual(['M 4', 'M 5', 'M 6', 'M 7', 'M 8.5', 'M 10', 'M 12']);
    expect([22, 23, 24, 25, 26.5, 28, 30].map((mp) => usBootSize(mp, 'womens'))).toEqual(['W 5', 'W 6', 'W 7', 'W 8', 'W 9.5', 'W 11', 'W 13']);
  });

  it('kids’ follow the chart, and men’s past MP 25', () => {
    expect([15.5, 16.5, 17.5, 18.5, 19, 19.5, 20, 21, 21.5, 22, 23, 24, 25].map((mp) => usBootSize(mp, 'Kids')))
      .toEqual(['C 8', 'C 9', 'C 10', 'C 11', 'C 12', 'C 13', 'Y 1', 'Y 2.5', 'Y 3', 'Y 4', 'Y 5', 'Y 6', 'Y 7']);
    expect(usBootSize(26, 'Kids')).toBe('M 8');
    expect(usBootSize(12, 'Kids')).toBeNull();
  });

  it('says nothing for a boot not marked Mens, Womens or Kids', () => {
    expect(usBootSize(26, 'Unisex')).toBeNull();
    expect(usBootSize(26, null)).toBeNull();
  });

  it('reads as MP, with the US size in parentheses when shown', () => {
    expect(bootSizeText(26.5, 'Mens', false)).toBe('MP 26.5');
    expect(bootSizeText(26.5, 'Mens', true)).toBe('MP 26.5 (US M 8.5)');
    expect(bootSizeText(26.5, 'Unisex', true)).toBe('MP 26.5');
  });
});
