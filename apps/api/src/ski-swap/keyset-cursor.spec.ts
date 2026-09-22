import { encodeCursor, decodeCursor } from './item.service';

/**
 * The bookmark a full item pass carries between pages (iOS Plan 17 E).
 *
 * Opaque on purpose: what it is made of is ours to change, and a client that
 * composed its own would pin the walk's ordering to whatever we happened to
 * sort by this month. What has to hold is that it round-trips, and that
 * something we did not mint is refused rather than half-understood.
 */
describe('the page cursor for a full item pass', () => {
  it('round-trips the place it names', () => {
    const at = new Date('2026-02-14T18:30:00.123Z');
    const back = decodeCursor(encodeCursor(at, 'item-42'));

    expect(back?.id).toBe('item-42');
    expect(back?.updatedAt.toISOString()).toBe(at.toISOString());
  });

  it('keeps the millisecond, which is the half that makes it a tiebreak', () => {
    // `updatedAt` is not unique. A cursor that rounded to the second would
    // either repeat or skip every row sharing one.
    const at = new Date('2026-02-14T18:30:00.999Z');
    expect(decodeCursor(encodeCursor(at, 'x'))?.updatedAt.getTime()).toBe(at.getTime());
  });

  it('survives an id with the separator in it', () => {
    // The encoding joins on `|`. A uuid has none, but nothing stops an id
    // minted elsewhere from having one, and a truncated id is still a valid
    // id — so the walk would seek to a different row and say nothing.
    const back = decodeCursor(encodeCursor(new Date('2026-01-01T00:00:00.000Z'), 'a|b'));
    expect(back?.id).toBe('a|b');
  });

  it('is url-safe, because it travels as a query parameter', () => {
    const cursor = encodeCursor(new Date('2026-02-14T18:30:00.123Z'), 'item-42');
    expect(cursor).toBe(encodeURIComponent(cursor));
  });

  it('refuses something it did not mint', () => {
    for (const bad of ['', 'not-base64!!', Buffer.from('nonsense').toString('base64url')]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it('refuses a cursor with no id, rather than seeking to everything', () => {
    expect(decodeCursor(Buffer.from('2026-01-01T00:00:00.000Z|').toString('base64url'))).toBeNull();
  });

  it('refuses a cursor whose date is not one', () => {
    expect(decodeCursor(Buffer.from('never|item-1').toString('base64url'))).toBeNull();
  });
});
