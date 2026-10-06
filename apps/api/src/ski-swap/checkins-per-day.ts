/**
 * The dashboard's check-ins per day (pure, so it can be tested): items by the
 * day they entered PatrolKit, in the swap's time zone, split by whether their
 * seller is a business. An issued ticket counts on the day it was issued,
 * since that's when its item was made.
 *
 * From the first day with a check-in to the last, with every day between,
 * empty ones included, so the gaps show.
 */

export interface CheckinDay {
  /** "2026-10-04", in the swap's time zone. */
  date: string;
  individual: number;
  business: number;
}

/** The calendar day an instant falls on, in a time zone: "2026-10-04". */
export function dayIn(at: Date, timeZone: string): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** The day after "2026-10-04". Plain calendar arithmetic, no zone involved. */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function checkinsPerDay(
  items: { createdAt: Date; business: boolean }[],
  timeZone: string,
): CheckinDay[] {
  const counts = new Map<string, CheckinDay>();
  for (const item of items) {
    const date = dayIn(item.createdAt, timeZone);
    const day = counts.get(date) ?? { date, individual: 0, business: 0 };
    if (item.business) day.business++;
    else day.individual++;
    counts.set(date, day);
  }
  if (counts.size === 0) return [];

  const dates = [...counts.keys()].sort();
  const out: CheckinDay[] = [];
  for (let d = dates[0]; d <= dates[dates.length - 1]; d = nextDay(d)) {
    out.push(counts.get(d) ?? { date: d, individual: 0, business: 0 });
  }
  return out;
}
