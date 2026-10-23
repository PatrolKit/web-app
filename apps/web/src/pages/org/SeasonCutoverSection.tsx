import { useState } from 'react';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
/** No February 29: a season has to start every year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const pad = (n: number) => String(n).padStart(2, '0');

/** The season a date falls in, named by its start year, for a cutover of `MM-DD`. */
export function seasonStartYear(date: Date, month: number, day: number): number {
  const m = date.getMonth() + 1;
  const onOrAfter = m > month || (m === month && date.getDate() >= day);
  return onOrAfter ? date.getFullYear() : date.getFullYear() - 1;
}

/** "2026–2027: July 1, 2026 to June 30, 2027", or "2026: …" when seasons are calendar years. */
export function describeSeason(startYear: number, month: number, day: number): string {
  const first = new Date(startYear, month - 1, day);
  const last = new Date(startYear + 1, month - 1, day - 1);
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const label = month === 1 && day === 1 ? String(startYear) : `${startYear}–${startYear + 1}`;
  return `${label}: ${fmt(first)} to ${fmt(last)}`;
}

/**
 * Seasons split the year at one date (Plan 55 D12). Time Tracking groups shifts and
 * hours by it; nothing is stored per season, so changing it regroups at once.
 */
export function SeasonCutoverSection({
  cutover,
  busy,
  onSave,
}: {
  cutover: string;
  busy: boolean;
  onSave: (cutover: string) => void;
}) {
  const [savedMonth, savedDay] = cutover.split('-').map(Number);
  const [month, setMonth] = useState(savedMonth ?? 7);
  const [day, setDay] = useState(savedDay ?? 1);
  const [confirming, setConfirming] = useState(false);

  const value = `${pad(month)}-${pad(day)}`;
  const changed = value !== cutover;
  const current = seasonStartYear(new Date(), month, day);

  return (
    <section className="space-y-3">
      <h2 className="text-white font-semibold">Season starts</h2>
      <p className="text-gray-400 text-sm">
        Time Tracking groups shifts and hours into seasons that start on this day each year.
      </p>
      <form
        onSubmit={(e) => { e.preventDefault(); if (changed) setConfirming(true); }}
        className="flex flex-wrap gap-2"
      >
        <label className="sr-only" htmlFor="season-month">Month</label>
        <select
          id="season-month"
          value={month}
          onChange={(e) => {
            const m = Number(e.target.value);
            setMonth(m);
            setDay((d) => Math.min(d, DAYS_IN_MONTH[m - 1]!));
          }}
          className="bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm"
        >
          {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
        </select>
        <label className="sr-only" htmlFor="season-day">Day</label>
        <select
          id="season-day"
          value={day}
          onChange={(e) => setDay(Number(e.target.value))}
          className="bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm"
        >
          {Array.from({ length: DAYS_IN_MONTH[month - 1]! }, (_, i) => (
            <option key={i + 1} value={i + 1}>{i + 1}</option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || !changed}
          className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm"
        >
          Save
        </button>
      </form>
      <p className="text-gray-300 text-sm">
        {changed ? 'With this date, the current season would be ' : 'Current season: '}
        {describeSeason(current, month, day)}.
      </p>

      {confirming && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-white font-semibold">Change when seasons start?</h3>
            <p className="text-gray-300 text-sm">
              Seasons will start on {MONTHS[month - 1]} {day}. Shifts and hours are grouped by the
              new dates at once. Nothing is moved.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirming(false)} className="text-gray-400 hover:text-white text-sm px-3 py-1.5">
                Cancel
              </button>
              <button
                onClick={() => { setConfirming(false); onSave(value); }}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-1.5 rounded text-sm"
              >
                Change
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
