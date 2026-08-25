import { autoClockOutAt, autoEventId, sweepAt } from './sweep.util';

const TZ = 'America/New_York';

describe('sweepAt (§5.6)', () => {
  it('picks the next 03:00 after a daytime clock-in, not that morning s', () => {
    // 08:00 EST on Jan 10 → the sweep is 03:00 on Jan 11, not Jan 10.
    const clockIn = new Date('2026-01-10T13:00:00Z');
    expect(sweepAt(clockIn, TZ, '03:00').toISOString()).toBe('2026-01-11T08:00:00.000Z');
  });

  it('picks the same night s 03:00 for a late-evening clock-in', () => {
    // 23:30 EST on Jan 10 → 03:00 on Jan 11, three and a half hours later.
    const clockIn = new Date('2026-01-11T04:30:00Z');
    expect(sweepAt(clockIn, TZ, '03:00').toISOString()).toBe('2026-01-11T08:00:00.000Z');
  });

  it('always lands strictly after the clock-in', () => {
    for (const hour of [0, 2, 3, 4, 8, 12, 18, 23]) {
      const clockIn = new Date(Date.UTC(2026, 0, 10, hour, 0, 0));
      expect(sweepAt(clockIn, TZ, '03:00').getTime()).toBeGreaterThan(clockIn.getTime());
    }
  });

  it('survives both daylight-saving transitions', () => {
    // Spring forward 2026-03-08, fall back 2026-11-01 — 03:00 exists exactly once on both.
    const spring = new Date('2026-03-07T18:00:00Z');
    const fall = new Date('2026-10-31T18:00:00Z');
    for (const clockIn of [spring, fall]) {
      const sweep = sweepAt(clockIn, TZ, '03:00');
      expect(sweep.getTime()).toBeGreaterThan(clockIn.getTime());
      const local = new Intl.DateTimeFormat('en-US', {
        timeZone: TZ,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(sweep);
      expect(local).toBe('03:00');
    }
  });
});

describe('autoClockOutAt (the §5.6 table)', () => {
  const cases: [string, string, string][] = [
    // clock-in (UTC),          expected clock-out (UTC),  why
    ['2026-01-10T13:00:00Z', '2026-01-10T17:00:00.000Z', '08:00 local → +4h = 12:00'],
    ['2026-01-11T03:30:00Z', '2026-01-11T07:30:00.000Z', '22:30 local → +4h = 02:30'],
    ['2026-01-11T04:30:00Z', '2026-01-11T08:00:00.000Z', '23:30 local → +4h past sweep'],
    ['2026-01-11T05:45:00Z', '2026-01-11T08:00:00.000Z', '00:45 local → +4h past sweep'],
  ];

  it.each(cases)('%s → %s (%s)', (clockIn, expected) => {
    expect(autoClockOutAt(new Date(clockIn), TZ, '03:00', 4).toISOString()).toBe(expected);
  });

  it('never records a clock-out before its clock-in', () => {
    const clockIn = new Date('2026-01-11T07:59:00Z');
    expect(autoClockOutAt(clockIn, TZ, '03:00', 4).getTime()).toBeGreaterThan(clockIn.getTime());
  });
});

describe('autoEventId', () => {
  it('derives the same id on every device, so duplicate closes are no-ops', () => {
    expect(autoEventId('shift-abc')).toBe('auto:shift-abc');
  });
});
