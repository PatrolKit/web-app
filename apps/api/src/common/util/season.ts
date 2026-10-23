import { instantForLocal, localParts } from '../../time-clock/sweep.util';

/**
 * Seasons split the year at one cutover date (Plan 55 D12).
 *
 * An org sets a month and day; each season runs from that day to the day before it the
 * following year, and is named by its start year. Nothing stores which season a row is
 * in: it is worked out from a local calendar date, so moving the cutover regroups
 * everything at once and moves nothing.
 */

/** Days per month in a year with no February 29: a season has to start every year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const DEFAULT_SEASON_CUTOVER = '07-01';

/** `MM-DD`, a real date, and never February 29. */
export function isValidCutover(cutover: string): boolean {
  const m = /^(\d{2})-(\d{2})$/.exec(cutover);
  if (!m) return false;
  const month = Number(m[1]);
  const day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
}

function parse(cutover: string): { month: number; day: number } {
  const [month, day] = (isValidCutover(cutover) ? cutover : DEFAULT_SEASON_CUTOVER).split('-').map(Number);
  return { month: month!, day: day! };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The start year of the season a local calendar date falls in. */
export function seasonOf(date: { year: number; month: number; day: number }, cutover: string): number {
  const c = parse(cutover);
  const onOrAfter = date.month > c.month || (date.month === c.month && date.day >= c.day);
  return onOrAfter ? date.year : date.year - 1;
}

/** The season an instant falls in, by its calendar date in `timeZone`. */
export function seasonAt(instant: Date, cutover: string, timeZone: string): number {
  return seasonOf(localParts(instant, timeZone), cutover);
}

/**
 * "2026–2027", or "2026" when the cutover is January 1 and a season is a calendar year.
 * The en dash is the one people write between years.
 */
export function seasonLabel(startYear: number, cutover: string): string {
  return parse(cutover).month === 1 && parse(cutover).day === 1
    ? String(startYear)
    : `${startYear}–${startYear + 1}`;
}

/** A season's first and last calendar days, inclusive, as `YYYY-MM-DD`. */
export function seasonDates(startYear: number, cutover: string): { startsOn: string; endsOn: string } {
  const c = parse(cutover);
  const last = new Date(Date.UTC(startYear + 1, c.month - 1, c.day) - 24 * 3600_000);
  return {
    startsOn: `${startYear}-${pad(c.month)}-${pad(c.day)}`,
    endsOn: `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`,
  };
}

/**
 * The season's span in one zone: from local midnight on its first day, up to but not
 * including local midnight on the next season's.
 */
export function seasonRange(startYear: number, cutover: string, timeZone: string): { from: Date; to: Date } {
  const c = parse(cutover);
  return {
    from: instantForLocal(startYear, c.month, c.day, 0, 0, timeZone),
    to: instantForLocal(startYear + 1, c.month, c.day, 0, 0, timeZone),
  };
}
