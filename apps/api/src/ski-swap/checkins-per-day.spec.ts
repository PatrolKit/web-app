import { checkinsPerDay, dayIn } from './checkins-per-day';

const at = (iso: string) => new Date(iso);

describe('check-ins per day', () => {
  it('counts by the day in the swap’s time zone, not UTC', () => {
    // 11 pm in New York on Oct 4 is Oct 5 in UTC.
    expect(dayIn(at('2026-10-05T03:00:00Z'), 'America/New_York')).toBe('2026-10-04');
  });

  it('splits individuals from businesses, and fills the days between with zeros', () => {
    expect(checkinsPerDay([
      { createdAt: at('2026-10-02T15:00:00Z'), business: true },
      { createdAt: at('2026-10-02T16:00:00Z'), business: false },
      { createdAt: at('2026-10-05T15:00:00Z'), business: false },
      { createdAt: at('2026-10-05T17:00:00Z'), business: false },
    ], 'America/New_York')).toEqual([
      { date: '2026-10-02', individual: 1, business: 1 },
      { date: '2026-10-03', individual: 0, business: 0 },
      { date: '2026-10-04', individual: 0, business: 0 },
      { date: '2026-10-05', individual: 2, business: 0 },
    ]);
  });

  it('runs across a month end', () => {
    const days = checkinsPerDay([
      { createdAt: at('2026-09-30T15:00:00Z'), business: false },
      { createdAt: at('2026-10-01T15:00:00Z'), business: false },
    ], 'America/New_York');
    expect(days.map((d) => d.date)).toEqual(['2026-09-30', '2026-10-01']);
  });

  it('is empty with no items', () => {
    expect(checkinsPerDay([], 'America/New_York')).toEqual([]);
  });
});
