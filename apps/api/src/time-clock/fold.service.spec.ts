import { foldEvents, entryChanges, type StoredEntry } from './fold.service';

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

describe('foldEvents (Plan 59 §3)', () => {
  const sweep = (entryId: string, autoAt: string, sweepIso: string, n = 1) =>
    clockOut(`sweep:${entryId}:${n}`, autoAt, { source: 'auto', entryId, sweepAt: at(sweepIso) });

  it('opens an entry for a lone clock-in', () => {
    const { entries, eventStatus } = foldEvents([clockIn('a', '2026-01-10T13:00:00Z')]);
    expect(entries).toEqual([expect.objectContaining({ id: 'a', status: 'open', clockOutAt: null })]);
    expect(eventStatus.get('a')).toBe('applied');
  });

  it('closes the shift a clock-out names', () => {
    const { entries } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('b', '2026-01-10T21:00:00Z', { entryId: 'a' }),
    ]);
    expect(entries[0]).toMatchObject({ status: 'closed', closeReason: 'manual', closeEventId: 'b', flagged: false });
  });

  it('carries duty type and note onto the entry', () => {
    const { entries } = foldEvents([clockIn('a', '2026-01-10T13:00:00Z', { dutyType: 'other', dutyNote: 'Race' })]);
    expect(entries[0]).toMatchObject({ dutyType: 'other', dutyNote: 'Race' });
  });

  it('is independent of arrival order', () => {
    const events = [clockOut('b', '2026-01-10T21:00:00Z', { entryId: 'a' }), clockIn('a', '2026-01-10T13:00:00Z')];
    expect(foldEvents(events).entries[0]).toMatchObject({ status: 'closed', closeEventId: 'b' });
  });

  it('makes a clock-in during an open shift a duplicate, anywhere (R2, E19)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockIn('b', '2026-01-11T04:00:00Z', { resortId: 'resort-2' }),
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'a', resortId: 'resort-1', status: 'open' });
    expect(eventStatus.get('b')).toBe('duplicate');
  });

  it('closes the shift through a duplicate clock-in it names (R3, E17)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('phone', '2026-01-10T13:00:00Z', { source: 'member' }),
      clockIn('ipad', '2026-01-10T13:05:00Z'),
      clockOut('ipad-out', '2026-01-10T21:00:00Z', { entryId: 'ipad' }),
    ]);
    expect(entries).toEqual([expect.objectContaining({ id: 'phone', status: 'closed', closeEventId: 'ipad-out' })]);
    expect(eventStatus.get('ipad')).toBe('duplicate');
  });

  it('opens the shift at an earlier clock-in that arrives late (E20)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('phone', '2026-01-10T14:00:00Z', { source: 'member' }),
      clockIn('ipad', '2026-01-10T13:00:00Z'),
      clockOut('out', '2026-01-10T21:00:00Z', { source: 'member', entryId: 'phone' }),
    ]);
    expect(entries).toEqual([expect.objectContaining({ id: 'ipad', status: 'closed', closeEventId: 'out' })]);
    expect(eventStatus.get('phone')).toBe('duplicate');
  });

  it('makes a clock-out naming another shift an orphan', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('a-out', '2026-01-10T15:00:00Z', { entryId: 'a' }),
      clockIn('b', '2026-01-10T17:00:00Z'),
      clockOut('late', '2026-01-10T18:00:00Z', { entryId: 'a' }),
    ]);
    expect(entries[1]).toMatchObject({ id: 'b', status: 'open' });
    expect(eventStatus.get('late')).toBe('orphan');
  });

  it('lets the earliest close win over a staff close (R4, E4)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('admin-close:a', '2026-01-10T21:00:00Z', { source: 'admin', entryId: 'a' }),
      clockOut('ipad-out', '2026-01-10T20:00:00Z', { entryId: 'a' }),
    ]);
    expect(entries[0]).toMatchObject({ clockOutAt: at('2026-01-10T20:00:00Z'), closeReason: 'manual' });
    expect(eventStatus.get('admin-close:a')).toBe('orphan');
  });

  it('places a sweep at its sweep moment: a clock-out before it wins (R4, E3)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      sweep('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z'),
      clockOut('out', '2026-01-10T21:00:00Z', { entryId: 'a' }),
    ]);
    expect(entries[0]).toMatchObject({ clockOutAt: at('2026-01-10T21:00:00Z'), closeReason: 'manual' });
    expect(eventStatus.get('sweep:a:1')).toBe('orphan');
  });

  it('places a sweep at its sweep moment: a clock-out after it is too late (R4, E12)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      sweep('a', '2026-01-10T17:00:00Z', '2026-01-11T08:00:00Z'),
      clockOut('out', '2026-01-11T08:01:00Z', { source: 'member', entryId: 'a' }),
    ]);
    expect(entries[0]).toMatchObject({ clockOutAt: at('2026-01-10T17:00:00Z'), closeReason: 'auto', flagged: true });
    expect(eventStatus.get('out')).toBe('orphan');
  });

  it('ignores an iPad\'s own auto clock-out (R5, E14)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z'),
      clockOut('auto:a', '2026-01-10T17:00:00Z', { source: 'device_auto', entryId: 'a' }),
    ]);
    expect(entries[0]).toMatchObject({ status: 'open' });
    expect(eventStatus.get('auto:a')).toBe('orphan');
  });

  it('flags a shift from someone inactive until staff close it (R9, E16)', () => {
    const open = foldEvents([clockIn('a', '2026-01-10T13:00:00Z', { statusNote: 'inactive_patroller' })]);
    expect(open.entries[0].flagged).toBe(true);
    const closed = foldEvents([
      clockIn('a', '2026-01-10T13:00:00Z', { statusNote: 'inactive_patroller' }),
      clockOut('admin-close:a', '2026-01-10T17:00:00Z', { source: 'admin', entryId: 'a' }),
    ]);
    expect(closed.entries[0].flagged).toBe(false);
  });

  it('keeps a duplicate a duplicate after a staff edit (R2, E26)', () => {
    const { entries, eventStatus } = foldEvents([
      clockIn('lodge', '2026-01-10T13:00:00Z'),
      clockIn('summit', '2026-01-11T04:00:00Z', { status: 'voided', statusNote: 'kept_duplicate', entryId: 'lodge' }),
      clockOut('sweep:lodge:1', '2026-01-10T21:00:00Z', { source: 'admin', entryId: 'lodge' }),
      clockOut('summit-out', '2026-01-11T06:00:00Z', { entryId: 'summit' }),
    ]);
    expect(entries).toEqual([expect.objectContaining({ id: 'lodge', closeReason: 'admin' })]);
    expect(eventStatus.has('summit')).toBe(false);
    expect(eventStatus.get('summit-out')).toBe('orphan');
  });

  it('lets a clock-out written before Plan 59, naming nothing, close the open shift', () => {
    const { entries } = foldEvents([clockIn('a', '2026-01-10T13:00:00Z'), clockOut('b', '2026-01-10T21:00:00Z')]);
    expect(entries[0]).toMatchObject({ status: 'closed', closeEventId: 'b' });
  });
});

describe('entryChanges (Plan 55 D5, D6)', () => {
  const folded = () =>
    foldEvents([clockIn('a', '2026-01-10T13:00:00Z'), clockOut('ax', '2026-01-10T19:00:00Z')]).entries;
  const stored = (opts: Partial<StoredEntry> = {}): StoredEntry => ({ ...folded()[0]!, deletedAt: null, ...opts });

  it('writes nothing when the replay agrees with what is stored', () => {
    expect(entryChanges([stored()], folded())).toEqual({ create: [], update: [], tombstone: [] });
  });

  it('creates an entry it has not seen', () => {
    expect(entryChanges([], folded()).create.map((s) => s.id)).toEqual(['a']);
  });

  it('updates an entry whose close moved', () => {
    const moved = stored({ clockOutAt: at('2026-01-10T18:00:00Z') });
    expect(entryChanges([moved], folded()).update.map((s) => s.id)).toEqual(['a']);
  });

  it('tombstones an entry the replay no longer produces, once', () => {
    const gone = stored({ id: 'gone' });
    expect(entryChanges([stored(), gone], folded()).tombstone).toEqual(['gone']);
    expect(entryChanges([stored(), { ...gone, deletedAt: new Date() }], folded()).tombstone).toEqual([]);
  });

  it('revives a tombstone the replay produces again', () => {
    const revived = entryChanges([stored({ deletedAt: new Date() })], folded());
    expect(revived.update.map((s) => s.id)).toEqual(['a']);
  });
});
