import { checksToCsv, phoneForHumans, CHECK_CSV_HEADERS, type CheckRow } from './checks-csv';

function row(over: Partial<CheckRow> = {}): CheckRow {
  return {
    sellerName: 'Dana Reyes',
    street: '12 Summit Rd',
    city: 'Stowe',
    state: 'VT',
    zip: '05672',
    phone: phoneForHumans('+18025551212'),
    amountCents: 4250,
    reference: 'line_abc',
    checkNumber: null,
    sentAt: null,
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

  it('carries the phone number, which is what the treasurer rings when a check bounces back', () => {
    expect(checksToCsv([row()])).toContain('"(802) 555-1212"');
  });

  it('defuses a number it could not format, which still starts with a plus', () => {
    expect(checksToCsv([row({ phone: phoneForHumans('+442071234567') })]))
      .toContain(`"'+442071234567"`);
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
    expect(checksToCsv([row({ sellerName: 'Dana "Danno" Reyes' })])).toContain(
      '"Dana ""Danno"" Reyes"',
    );
  });

  it('defuses a name a spreadsheet would run as a formula', () => {
    // Not hypothetical: a hyphenated surname typed without its first part, and
    // Excel evaluates it.
    expect(checksToCsv([row({ sellerName: '-Smith' })])).toContain(`"'-Smith"`);
    expect(checksToCsv([row({ sellerName: '=1+1' })])).toContain(`"'=1+1"`);
    expect(checksToCsv([row({ sellerName: '@here' })])).toContain(`"'@here"`);
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

  it('dates a sent check to the day, which is all a register needs', () => {
    const out = checksToCsv([row({ sentAt: new Date('2026-02-14T18:30:00Z'), checkNumber: '1043' })]);
    expect(out).toContain('"1043","2026-02-14"');
  });

  it('ends with a newline so the last row survives import', () => {
    expect(checksToCsv([row()]).endsWith('\r\n')).toBe(true);
  });
});
