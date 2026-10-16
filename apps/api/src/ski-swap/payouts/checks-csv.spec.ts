import { addressText, addressToDestination, checksToCsv, destinationToAddress, phoneForHumans, CHECK_CSV_HEADERS, type CheckRow } from './checks-csv';

function row(over: Partial<CheckRow> = {}): CheckRow {
  return {
    payee: 'Dana Reyes',
    street: '12 Summit Rd',
    city: 'Stowe',
    state: 'VT',
    zip: '05672',
    amountCents: 4250,
    memo: 'Fall Ski Swap payout: 3 items',
    date: new Date('2026-10-16T18:30:00Z'),
    ...over,
  };
}

/** Commas that actually separate fields — the ones outside any quoted cell. */
function topLevelCommas(line: string): number {
  let inQuotes = false;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ',' && !inQuotes) count++;
  }
  return count;
}

describe('phoneForHumans', () => {
  it('reads a US number the way somebody about to dial it would', () => {
    expect(phoneForHumans('+18025551212')).toBe('(802) 555-1212');
  });

  it('handles a ten-digit number with no country code', () => {
    expect(phoneForHumans('8025551212')).toBe('(802) 555-1212');
  });

  it('leaves a number it does not recognise exactly as stored', () => {
    // Mangling an international number to make it look tidy would be worse
    // than leaving it alone: the digits are what somebody has to dial.
    expect(phoneForHumans('+442071234567')).toBe('+442071234567');
  });

  it('is unchanged by being applied twice', () => {
    expect(phoneForHumans(phoneForHumans('+18025551212'))).toBe('(802) 555-1212');
  });

  it('says nothing for a seller with no number', () => {
    expect(phoneForHumans(null)).toBe('');
  });
});

describe('checksToCsv', () => {
  it('writes the agreed columns in the agreed order', () => {
    expect(checksToCsv([]).trim()).toBe(CHECK_CSV_HEADERS.join(','));
  });

  it('writes payee, address, amount, memo and date, in that order', () => {
    expect(checksToCsv([row()]).split('\r\n')[1]).toBe('"Dana Reyes","12 Summit Rd","Stowe","VT","05672",42.50,"Fall Ski Swap payout: 3 items","2026-10-16"');
  });

  it('writes the amount as a bare decimal so the column can be summed', () => {
    const line = checksToCsv([row({ amountCents: 123456 })]).split('\r\n')[1];
    expect(line).toContain(',1234.56,');
    expect(line).not.toContain('$');
  });

  it('quotes a comma in an address instead of splitting the row', () => {
    const out = checksToCsv([row({ street: '12 Summit Rd, Apt 4' })]);
    expect(out).toContain('"12 Summit Rd, Apt 4"');
    // Ten fields, no more: the comma stayed inside its cell rather than
    // shifting every column after it by one.
    expect(topLevelCommas(out.split('\r\n')[1])).toBe(CHECK_CSV_HEADERS.length - 1);
  });

  it('doubles a quote in a name', () => {
    expect(checksToCsv([row({ payee: 'Dana "Danno" Reyes' })])).toContain(
      '"Dana ""Danno"" Reyes"',
    );
  });

  it('defuses a name a spreadsheet would run as a formula', () => {
    // Not hypothetical: a hyphenated surname typed without its first part, and
    // Excel evaluates it.
    expect(checksToCsv([row({ payee: '-Smith' })])).toContain(`"'-Smith"`);
    expect(checksToCsv([row({ payee: '=1+1' })])).toContain(`"'=1+1"`);
    expect(checksToCsv([row({ payee: '@here' })])).toContain(`"'@here"`);
  });

  it('leaves an ordinary name alone', () => {
    expect(checksToCsv([row()])).toContain('"Dana Reyes"');
  });

  it('flattens a newline pasted into an address rather than ending the row early', () => {
    const out = checksToCsv([row({ street: '12 Summit Rd\nApt 4' })]);
    expect(out.trimEnd().split('\r\n')).toHaveLength(2);
    expect(out).toContain('"12 Summit Rd Apt 4"');
  });

  it('writes a missing address as empty, not as "null"', () => {
    const out = checksToCsv([row({ street: null, city: null, state: null, zip: null })]);
    expect(out).not.toContain('null');
    expect(out).toContain('"Dana Reyes","","","",""');
  });


  it('ends with a newline so the last row survives import', () => {
    expect(checksToCsv([row()]).endsWith('\r\n')).toBe(true);
  });
});

describe('a check line\'s frozen address', () => {
  it('round-trips through the line\'s destination', () => {
    const a = { street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672' };
    expect(destinationToAddress(addressToDestination(a))).toEqual(a);
  });

  it('reads as one line', () => {
    expect(addressText({ street: '12 Summit Rd', city: 'Stowe', state: 'VT', zip: '05672' })).toBe('12 Summit Rd, Stowe, VT 05672');
    expect(addressText({ street: null, city: null, state: null, zip: null })).toBeNull();
  });
});
