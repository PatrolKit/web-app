import { deriveName, renderAnswer, type NameAnswer } from './derive-name';

function attr(
  label: string,
  nameSlot: number | null,
  opts: { unit?: string | null; displayOrder?: number } = {},
) {
  return {
    id: `att_${label.toLowerCase()}`,
    label,
    nameSlot,
    unit: opts.unit ?? null,
    displayOrder: opts.displayOrder ?? 0,
  };
}

describe('deriveName', () => {
  it('puts the category last and the answers in slot order', () => {
    // The worked example from the plan's brief.
    const answers: NameAnswer[] = [
      { attribute: attr('Type', 40), valueLabel: 'Powder' },
      { attribute: attr('Manufacturer', 10), valueLabel: 'Head' },
      { attribute: attr('Length', 30, { unit: 'cm' }), numberValue: 112 },
      { attribute: attr('Model', 20), valueLabel: 'Kore' },
    ];
    expect(deriveName('Skis', answers)).toBe('Head Kore 112cm Powder Skis');
  });

  it('composes the jacket example', () => {
    const answers: NameAnswer[] = [
      { attribute: attr('Manufacturer', 10), valueLabel: 'Helly Hansen' },
      { attribute: attr('Gender', 20), valueLabel: 'Mens' },
      { attribute: attr('Color', 30), valueLabel: 'Blue' },
    ];
    expect(deriveName('Jacket', answers)).toBe('Helly Hansen Mens Blue Jacket');
  });

  it('is the bare category when nothing was answered', () => {
    // D6: a category and a price is a valid item, and this is its name.
    expect(deriveName('Skis', [])).toBe('Skis');
  });

  it('omits an answer reached through a "same details as" pointer (Plan 44 D15)', () => {
    const answers: NameAnswer[] = [
      { attribute: attr('Manufacturer', 10), valueLabel: 'Völkl' },
      { attribute: attr('Length', 30, { unit: 'cm' }), numberValue: 170 },
      { attribute: attr('Manufacturer', 10), valueLabel: 'Marker', viaPointer: true },
      { attribute: attr('Model', 15), valueLabel: 'Griffon 13 ID', viaPointer: true },
    ];
    expect(deriveName('Skis', answers)).toBe('Völkl 170cm Skis');
  });

  it('omits an answer whose attribute has no slot', () => {
    const answers: NameAnswer[] = [
      { attribute: attr('Manufacturer', 10), valueLabel: 'Head' },
      { attribute: attr('Rocker profile', null), valueLabel: 'Early rise' },
    ];
    expect(deriveName('Skis', answers)).toBe('Head Skis');
  });

  it('breaks a slot tie by displayOrder, then by label', () => {
    const answers: NameAnswer[] = [
      { attribute: attr('Zebra', 10, { displayOrder: 2 }), valueLabel: 'second' },
      { attribute: attr('Alpha', 10, { displayOrder: 1 }), valueLabel: 'first' },
    ];
    expect(deriveName('Skis', answers)).toBe('first second Skis');
  });

  it('skips an answer that resolved to nothing', () => {
    // A cleared select arrives as a row with neither value nor number.
    const answers: NameAnswer[] = [
      { attribute: attr('Manufacturer', 10), valueLabel: null },
      { attribute: attr('Type', 20), valueLabel: 'Powder' },
    ];
    expect(deriveName('Skis', answers)).toBe('Powder Skis');
  });

  it('collapses whitespace rather than passing it to a label renderer', () => {
    const answers: NameAnswer[] = [{ attribute: attr('Manufacturer', 10), valueLabel: 'Helly  Hansen' }];
    expect(deriveName('Jacket', answers)).toBe('Helly Hansen Jacket');
  });
});

describe('renderAnswer', () => {
  it('appends a unit with no space', () => {
    expect(renderAnswer({ attribute: attr('Length', 10, { unit: 'cm' }), numberValue: 112 })).toBe('112cm');
  });

  it('drops a trailing .0 that MySQL floats arrive with', () => {
    expect(renderAnswer({ attribute: attr('Length', 10, { unit: 'cm' }), numberValue: 112.0 })).toBe('112cm');
  });

  it('keeps a genuine fraction, to two places', () => {
    expect(renderAnswer({ attribute: attr('Mondo', 10, { unit: '' }), numberValue: 26.5 })).toBe('26.5');
  });

  it('renders a number with no unit as the bare number', () => {
    expect(renderAnswer({ attribute: attr('Flex', 10), numberValue: 100 })).toBe('100');
  });

  it('prefers a value label over a number when both somehow arrive', () => {
    expect(
      renderAnswer({ attribute: attr('Type', 10), valueLabel: 'Powder', numberValue: 7 }),
    ).toBe('Powder');
  });

  it('is null when there is no answer at all', () => {
    expect(renderAnswer({ attribute: attr('Type', 10) })).toBeNull();
  });
});

describe('deriveName in "Other"', () => {
  const what = { ...attr('What is it?', 10), allowFreeEntry: true };
  const color = attr('Color', 20);
  it('names the item by what it is, in place of "Other"', () => {
    expect(deriveName('Other', [
      { attribute: what, valueLabel: 'Sled' },
      { attribute: color, valueLabel: 'Red' },
    ])).toBe('Red Sled');
  });
  it('keeps "Other" when nothing says what it is', () => {
    expect(deriveName('Other', [{ attribute: color, valueLabel: 'Red' }])).toBe('Red Other');
    expect(deriveName('Other', [])).toBe('Other');
  });
  it('leaves every other category as it was', () => {
    const maker = { ...attr('Manufacturer', 10), allowFreeEntry: true };
    expect(deriveName('Skis', [{ attribute: maker, valueLabel: 'Head' }])).toBe('Head Skis');
  });
});

describe('a ski boot’s size', () => {
  const boot = (mp: number, gender?: string): NameAnswer[] => [
    { attribute: attr('Manufacturer', 10), valueLabel: 'Nordica' },
    { attribute: attr('Mondopoint', 30), numberValue: mp },
    ...(gender ? [{ attribute: attr('Gender', 40), valueLabel: gender }] : []),
  ];

  it('reads "MP" after the noun, so it can’t be taken for something else', () => {
    expect(deriveName('Ski boots', boot(26.5, 'Mens'))).toBe('Nordica Mens Ski boots MP 26.5');
    expect(deriveName('Ski boots', [{ attribute: attr('Mondopoint', 30), numberValue: 22 }])).toBe('Ski boots MP 22');
  });

  it('adds the US size where the org shows them and the boot says who it’s for', () => {
    const us = { showUsBootSizes: true };
    expect(deriveName('Ski boots', boot(26.5, 'Mens'), us)).toBe('Nordica Mens Ski boots MP 26.5 (US M 8.5)');
    expect(deriveName('Ski boots', boot(24, 'Womens'), us)).toBe('Nordica Womens Ski boots MP 24 (US W 7)');
    expect(deriveName('Ski boots', boot(22, 'Kids'), us)).toBe('Nordica Kids Ski boots MP 22 (US Y 4)');
    // Unisex, or no gender: the MP alone.
    expect(deriveName('Ski boots', boot(26, 'Unisex'), us)).toBe('Nordica Unisex Ski boots MP 26');
    expect(deriveName('Ski boots', boot(26), us)).toBe('Nordica Ski boots MP 26');
  });

  it('leaves other numbers where they were', () => {
    expect(deriveName('Skis', [{ attribute: attr('Length', 30, { unit: 'cm' }), numberValue: 170 }])).toBe('170cm Skis');
  });
});
