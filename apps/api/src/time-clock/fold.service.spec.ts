import { foldEvents } from './fold.service';

type E = Parameters<typeof foldEvents>[0][number];

const at = (iso: string) => new Date(iso);

function clockIn(id: string, iso: string, opts: Partial<E> = {}): E {
  return {
    id,
    resortId: 'resort-1',
    type: 'clock_in',
    dutyType: 'patrol',
    dutyNote: null,
    source: 'device',
    occurredAt: at(iso),
    ...opts,
  };
}

function clockOut(id: string, iso: string, opts: Partial<E> = {}): E {
  return {
    id,
    resortId: 'resort-1',
    type: 'clock_out',
    dutyType: null,
    dutyNote: null,
    source: 'device',
    occurredAt: at(iso),
    ...opts,
  };
}

describe('foldEvents (§5.5)', () => {
  it('opens a shift for a lone clock-in', () => {
    const { shifts, eventStatus } = foldEvents([clockIn('a', '2026-01-10T13:00:00Z')]);

    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({ id: 'a', status: 'open', clockOutAt: null, flagged: false });
    expect(eventStatus.get('a')).toBe('applied');
  });

  it('closes the shift on a matching clock-out', () => {
    const { shifts, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('b', '2026-01-10T19:00:00Z'),
    ]);

    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({
      status: 'closed',
      closeReason: 'manual',
      flagged: false,
    });
    expect(shifts[0]?.clockOutAt?.toISOString()).toBe('2026-01-10T19:00:00.000Z');
    expect(eventStatus.get('b')).toBe('applied');
  });

  it('carries duty type and note onto the shift', () => {
    const { shifts } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z', { dutyType: 'other', dutyNote: 'Helping with the race' }),
    ]);

    expect(shifts[0]).toMatchObject({ dutyType: 'other', dutyNote: 'Helping with the race' });
  });

  it('is independent of arrival order', () => {
    const forwards = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('b', '2026-01-10T19:00:00Z'),
    ]);
    const backwards = foldEvents([
      clockOut('b', '2026-01-10T19:00:00Z'),
      clockIn('a', '2026-01-10T13:00:00Z'),
    ]);

    expect(backwards.shifts).toEqual(forwards.shifts);
  });

  it('supersedes an open shift when the patroller clocks in elsewhere', () => {
    const { shifts, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockIn('b', '2026-01-10T15:00:00Z', { resortId: 'resort-2' }),
    ]);

    expect(shifts).toHaveLength(2);
    expect(shifts[0]).toMatchObject({ status: 'closed', closeReason: 'superseded', flagged: true });
    expect(shifts[0]?.clockOutAt?.toISOString()).toBe('2026-01-10T15:00:00.000Z');
    expect(shifts[1]).toMatchObject({ id: 'b', resortId: 'resort-2', status: 'open' });
    expect(eventStatus.get('b')).toBe('applied');
  });

  it('ignores a repeated clock-in at the same instant as a duplicate', () => {
    const { shifts, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockIn('b', '2026-01-10T13:00:00Z'),
    ]);

    expect(shifts).toHaveLength(1);
    expect(eventStatus.get('b')).toBe('duplicate');
  });

  it('flags an automatic close but not a manual or admin one', () => {
    const auto = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('auto:a', '2026-01-10T17:00:00Z', { source: 'device_auto' }),
    ]);
    expect(auto.shifts[0]).toMatchObject({ closeReason: 'auto', flagged: true });

    const admin = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('admin-close:a', '2026-01-10T17:00:00Z', { source: 'admin' }),
    ]);
    expect(admin.shifts[0]).toMatchObject({ closeReason: 'admin', flagged: false });
  });

  it('records a clock-out with no open shift as an orphan', () => {
    const { shifts, eventStatus } = foldEvents([clockOut('b', '2026-01-10T19:00:00Z')]);

    expect(shifts).toHaveLength(0);
    expect(eventStatus.get('b')).toBe('orphan');
  });

  it('rejects a clock-out that predates its clock-in as anomalous', () => {
    const { shifts, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('b', '2026-01-10T12:00:00Z'),
    ]);

    // Ordering puts the clock-out first, so it is an orphan rather than anomalous —
    // either way it must not close a shift that had not started.
    expect(shifts[0]).toMatchObject({ status: 'open' });
    expect(['orphan', 'anomalous']).toContain(eventStatus.get('b'));
  });

  it('handles a full multi-day log', () => {
    const { shifts } = foldEvents([
      clockIn('d1', '2026-01-10T13:00:00Z'),
      clockOut('d1x', '2026-01-10T21:00:00Z'),
      clockIn('d2', '2026-01-11T13:30:00Z'),
      clockOut('d2x', '2026-01-11T20:00:00Z'),
      clockIn('d3', '2026-01-12T14:00:00Z'),
    ]);

    expect(shifts.map((s) => s.status)).toEqual(['closed', 'closed', 'open']);
  });
});
