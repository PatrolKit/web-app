import { ONLINE_WITHIN_MS, resortStatuses } from './health.service';

const now = Date.parse('2026-11-18T15:00:00Z');
const ago = (ms: number) => new Date(now - ms);

describe('resortStatuses (Overview)', () => {
  it('counts a resort online while any of its iPads checked in recently', () => {
    const [lodge] = resortStatuses(
      ['lodge'],
      [
        { resortId: 'lodge', lastSeenAt: ago(30_000) },
        { resortId: 'lodge', lastSeenAt: ago(2 * 3600_000) },
      ],
      now,
    );

    expect(lodge).toEqual({ resortId: 'lodge', iPads: 2, online: 1, lastSeenAt: ago(30_000).toISOString() });
  });

  it('is offline once every iPad is quieter than the window, dated by the latest', () => {
    const [summit] = resortStatuses(
      ['summit'],
      [
        { resortId: 'summit', lastSeenAt: ago(ONLINE_WITHIN_MS + 1) },
        { resortId: 'summit', lastSeenAt: ago(5 * 3600_000) },
      ],
      now,
    );

    expect(summit.online).toBe(0);
    expect(summit.lastSeenAt).toBe(ago(ONLINE_WITHIN_MS + 1).toISOString());
  });

  it('says so when a resort has no iPad, or one that never checked in', () => {
    const [empty, never] = resortStatuses(
      ['empty', 'never'],
      [{ resortId: 'never', lastSeenAt: null }, { resortId: null, lastSeenAt: ago(0) }],
      now,
    );

    expect(empty).toEqual({ resortId: 'empty', iPads: 0, online: 0, lastSeenAt: null });
    expect(never).toEqual({ resortId: 'never', iPads: 1, online: 0, lastSeenAt: null });
  });
});
