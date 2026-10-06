/**
 * The dashboard's check-ins heat map (pure, so it can be tested): items by
 * the day and hour they entered PatrolKit, in the swap's time zone. Each cell
 * carries its items, individuals and businesses apart, and which sellers they
 * came from, so the card can count sellers once however it's filtered.
 *
 * Days run from the first with a check-in to the last, every day between
 * included; hours from the earliest hour any day saw one to the latest. An
 * issued ticket counts when it was issued, since that's when its item was made.
 */

export interface CheckinCell {
  /** "2026-10-04", in the swap's time zone. */
  date: string;
  /** 0–23, in the swap's time zone. */
  hour: number;
  individual: number;
  business: number;
  /** Indexes into `sellers`: who checked items in this hour. */
  sellers: number[];
}

export interface CheckinsHeatmap {
  days: string[];
  hours: number[];
  /** Only cells with a check-in. */
  cells: CheckinCell[];
  /** Every seller in a cell, once: whether they're a business. */
  sellers: { business: boolean }[];
}

/** The calendar day an instant falls on, in a time zone: "2026-10-04". */
export function dayIn(at: Date, timeZone: string): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The hour (0–23) an instant falls in, in a time zone. */
export function hourIn(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(at));
}

/** The day after "2026-10-04". Plain calendar arithmetic, no zone involved. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function checkinsHeatmap(
  items: { createdAt: Date; sellerId: string | null; business: boolean }[],
  timeZone: string,
): CheckinsHeatmap {
  const cells = new Map<string, CheckinCell>();
  const sellerIndex = new Map<string, number>();
  const sellers: { business: boolean }[] = [];

  for (const item of items) {
    const date = dayIn(item.createdAt, timeZone);
    const hour = hourIn(item.createdAt, timeZone);
    const key = `${date} ${hour}`;
    const cell = cells.get(key) ?? { date, hour, individual: 0, business: 0, sellers: [] };
    if (item.business) cell.business++;
    else cell.individual++;
    if (item.sellerId) {
      let at = sellerIndex.get(item.sellerId);
      if (at === undefined) {
        at = sellers.length;
        sellerIndex.set(item.sellerId, at);
        sellers.push({ business: item.business });
      }
      if (!cell.sellers.includes(at)) cell.sellers.push(at);
    }
    cells.set(key, cell);
  }
  if (cells.size === 0) return { days: [], hours: [], cells: [], sellers: [] };

  const list = [...cells.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hour - b.hour);
  const dates = list.map((c) => c.date);
  const days: string[] = [];
  for (let d = dates[0]; d <= dates[dates.length - 1]; d = nextDay(d)) days.push(d);
  const lo = Math.min(...list.map((c) => c.hour));
  const hi = Math.max(...list.map((c) => c.hour));
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return { days, hours, cells: list, sellers };
}
