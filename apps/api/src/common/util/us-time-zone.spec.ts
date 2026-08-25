import { timeZoneForAddress, isValidTimeZone, US_TIME_ZONES } from './us-time-zone';

describe('timeZoneForAddress', () => {
  it('resolves single-zone states from the state alone', () => {
    expect(timeZoneForAddress({ state: 'CO' })).toBe('America/Denver');
    expect(timeZoneForAddress({ state: 'vt' })).toBe('America/New_York');
    expect(timeZoneForAddress({ state: ' UT ' })).toBe('America/Denver');
  });

  it('resolves the ski areas that live in split states', () => {
    // Schweitzer, Sandpoint ID — panhandle, Pacific despite Idaho being Mountain
    expect(timeZoneForAddress({ state: 'ID', zip: '83864' })).toBe('America/Los_Angeles');
    // Sun Valley ID — Mountain
    expect(timeZoneForAddress({ state: 'ID', zip: '83353' })).toBe('America/Boise');
    // Indianhead, Ironwood MI — Central UP
    expect(timeZoneForAddress({ state: 'MI', zip: '49938' })).toBe('America/Chicago');
    // Mount Bohemia, Keweenaw MI — Eastern UP
    expect(timeZoneForAddress({ state: 'MI', zip: '49950' })).toBe('America/Detroit');
    // Terry Peak, Lead SD — west river, Mountain
    expect(timeZoneForAddress({ state: 'SD', zip: '57754' })).toBe('America/Denver');
    // Ober Mountain, Gatlinburg TN — East Tennessee
    expect(timeZoneForAddress({ state: 'TN', zip: '37738' })).toBe('America/New_York');
    // Arizona Snowbowl, Flagstaff — Phoenix, no DST
    expect(timeZoneForAddress({ state: 'AZ', zip: '86001' })).toBe('America/Phoenix');
  });

  it('keeps the split-state boundaries on the right side', () => {
    expect(timeZoneForAddress({ state: 'FL', zip: '32502' })).toBe('America/Chicago'); // Pensacola
    expect(timeZoneForAddress({ state: 'FL', zip: '32301' })).toBe('America/New_York'); // Tallahassee
    expect(timeZoneForAddress({ state: 'KY', zip: '42101' })).toBe('America/Chicago'); // Bowling Green
    expect(timeZoneForAddress({ state: 'KY', zip: '40202' })).toBe('America/New_York'); // Louisville
    expect(timeZoneForAddress({ state: 'TX', zip: '79901' })).toBe('America/Denver'); // El Paso
    expect(timeZoneForAddress({ state: 'TX', zip: '79830' })).toBe('America/Chicago'); // Alpine
    expect(timeZoneForAddress({ state: 'NE', zip: '69301' })).toBe('America/Denver'); // Alliance
    expect(timeZoneForAddress({ state: 'NE', zip: '68102' })).toBe('America/Chicago'); // Omaha
  });

  it('lets the ZIP override a state that was typed wrong', () => {
    expect(timeZoneForAddress({ state: 'WA', zip: '83864' })).toBe('America/Los_Angeles');
  });

  it('falls back to the state when the ZIP is junk or missing', () => {
    expect(timeZoneForAddress({ state: 'MT', zip: '' })).toBe('America/Denver');
    expect(timeZoneForAddress({ state: 'MT', zip: 'abcde' })).toBe('America/Denver');
    expect(timeZoneForAddress({ state: 'MT' })).toBe('America/Denver');
  });

  it('returns null when there is nothing to go on', () => {
    expect(timeZoneForAddress({})).toBeNull();
    expect(timeZoneForAddress({ state: 'ZZ' })).toBeNull();
    expect(timeZoneForAddress({ state: '', zip: '' })).toBeNull();
  });

  it('only ever returns zones the override picker offers', () => {
    const zones = new Set<string>(US_TIME_ZONES);
    for (const state of ['CO', 'ID', 'MI', 'AZ', 'HI', 'AK', 'PR', 'IN']) {
      const zone = timeZoneForAddress({ state });
      expect(zone && zones.has(zone)).toBe(true);
    }
  });

  it('returns zones the runtime actually knows', () => {
    for (const zone of US_TIME_ZONES) expect(isValidTimeZone(zone)).toBe(true);
  });
});

describe('isValidTimeZone', () => {
  it('rejects names Intl cannot resolve', () => {
    expect(isValidTimeZone('America/Nowhere')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
