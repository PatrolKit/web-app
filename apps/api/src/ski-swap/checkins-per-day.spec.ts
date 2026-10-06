import { checkinsHeatmap, dayIn, hourIn } from './checkins-per-day';

const at = (iso: string) => new Date(iso);
const NY = 'America/New_York';

describe('the check-ins heat map', () => {
  it('places an item by its day and hour in the swap’s time zone, not UTC', () => {
    // 11 pm in New York on Oct 4 is Oct 5 in UTC.
    expect(dayIn(at('2026-10-05T03:00:00Z'), NY)).toBe('2026-10-04');
    expect(hourIn(at('2026-10-05T03:00:00Z'), NY)).toBe(23);
  });

  it('counts items and sellers per hour, individuals and businesses apart', () => {
    const map = checkinsHeatmap([
      { createdAt: at('2026-10-05T18:10:00Z'), sellerId: 'ann', business: false },
      { createdAt: at('2026-10-05T18:40:00Z'), sellerId: 'ann', business: false },
      { createdAt: at('2026-10-05T18:50:00Z'), sellerId: 'shop', business: true },
    ], NY);
    expect(map.cells).toEqual([{ date: '2026-10-05', hour: 14, individual: 2, business: 1, sellers: [0, 1] }]);
    expect(map.sellers).toEqual([{ business: false }, { business: true }]);
  });

  it('runs every day and every hour between the first and the last, gaps included', () => {
    const map = checkinsHeatmap([
      { createdAt: at('2026-10-02T15:00:00Z'), sellerId: 'a', business: false },
      { createdAt: at('2026-10-05T19:00:00Z'), sellerId: 'b', business: false },
    ], NY);
    expect(map.days).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    expect(map.hours).toEqual([11, 12, 13, 14, 15]);
  });

  it('is empty with no items', () => {
    expect(checkinsHeatmap([], NY)).toEqual({ days: [], hours: [], cells: [], sellers: [] });
  });
});
