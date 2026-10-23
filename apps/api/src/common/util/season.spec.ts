import { isValidCutover, seasonAt, seasonDates, seasonLabel, seasonOf, seasonRange } from './season';

describe('seasons (Plan 55 D12)', () => {
  describe('isValidCutover', () => {
    it.each(['07-01', '01-01', '12-31', '02-28', '04-30'])('accepts %s', (c) => {
      expect(isValidCutover(c)).toBe(true);
    });
    it.each(['02-29', '04-31', '13-01', '00-10', '7-1', '07/01', ''])('refuses %s', (c) => {
      expect(isValidCutover(c)).toBe(false);
    });
  });

  describe('seasonOf', () => {
    it('puts the day before the cutover in the season before', () => {
      expect(seasonOf({ year: 2027, month: 6, day: 30 }, '07-01')).toBe(2026);
    });
    it('starts a season on the cutover itself', () => {
      expect(seasonOf({ year: 2026, month: 7, day: 1 }, '07-01')).toBe(2026);
    });
    it('keeps the winter in the season that began the summer before', () => {
      expect(seasonOf({ year: 2027, month: 1, day: 15 }, '07-01')).toBe(2026);
    });
    it('makes calendar years of a January 1 cutover', () => {
      expect(seasonOf({ year: 2026, month: 1, day: 1 }, '01-01')).toBe(2026);
      expect(seasonOf({ year: 2026, month: 12, day: 31 }, '01-01')).toBe(2026);
    });
  });

  describe('seasonLabel and seasonDates', () => {
    it('names a season by the years it spans', () => {
      expect(seasonLabel(2026, '07-01')).toBe('2026–2027');
      expect(seasonDates(2026, '07-01')).toEqual({ startsOn: '2026-07-01', endsOn: '2027-06-30' });
    });
    it('names a calendar-year season by its year alone', () => {
      expect(seasonLabel(2026, '01-01')).toBe('2026');
      expect(seasonDates(2026, '01-01')).toEqual({ startsOn: '2026-01-01', endsOn: '2026-12-31' });
    });
    it('ends a March 1 season on whichever day February ends', () => {
      expect(seasonDates(2027, '03-01').endsOn).toBe('2028-02-29');
      expect(seasonDates(2026, '03-01').endsOn).toBe('2027-02-28');
    });
  });

  describe('seasonRange', () => {
    it("starts at local midnight in the resort's zone", () => {
      const { from, to } = seasonRange(2026, '07-01', 'America/Denver');
      expect(from.toISOString()).toBe('2026-07-01T06:00:00.000Z');
      expect(to.toISOString()).toBe('2027-07-01T06:00:00.000Z');
    });

    it('lands on local midnight across a DST change', () => {
      // November 1 is standard time in New York; the season began in daylight time.
      const { from, to } = seasonRange(2026, '11-01', 'America/New_York');
      expect(from.toISOString()).toBe('2026-11-01T04:00:00.000Z');
      expect(to.toISOString()).toBe('2027-11-01T04:00:00.000Z');
      const march = seasonRange(2027, '03-15', 'America/New_York');
      expect(march.from.toISOString()).toBe('2027-03-15T04:00:00.000Z');
    });

    it('agrees with seasonAt on both sides of the boundary', () => {
      const { from } = seasonRange(2026, '07-01', 'America/Denver');
      expect(seasonAt(from, '07-01', 'America/Denver')).toBe(2026);
      expect(seasonAt(new Date(from.getTime() - 1), '07-01', 'America/Denver')).toBe(2025);
    });
  });
});
