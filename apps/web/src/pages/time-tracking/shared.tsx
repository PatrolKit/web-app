const DUTY_STYLES: Record<string, string> = {
  patrol: 'bg-red-500/15 text-red-400',
  training: 'bg-blue-500/15 text-blue-400',
  instruction: 'bg-green-500/15 text-green-400',
  other: 'bg-gray-500/15 text-gray-400',
};

export function DutyBadge({ dutyType }: { dutyType: string }) {
  const style = DUTY_STYLES[dutyType] ?? DUTY_STYLES.other;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${style}`}>
      {dutyType}
    </span>
  );
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function elapsedLabel(fromIso: string, toIso?: string | null): string {
  const start = new Date(fromIso).getTime();
  const end = toIso ? new Date(toIso).getTime() : Date.now();
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `datetime-local` wants no timezone suffix; the API wants ISO with one. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

/** A season by its start year, or custom dates (Plan 55 D12). */
export type Period = { kind: 'season'; startYear: number } | { kind: 'custom'; from: string; to: string };

/** The query a period asks for: a season, or the dates as local midnights. */
export function periodParams(period: Period | null): { season?: number; from?: string; to?: string } {
  if (!period) return {};
  if (period.kind === 'season') return { season: period.startYear };
  return {
    from: period.from ? new Date(`${period.from}T00:00`).toISOString() : undefined,
    // Through the end of the last day asked for.
    to: period.to ? new Date(`${period.to}T23:59:59.999`).toISOString() : undefined,
  };
}

/**
 * Seasons first, current one preselected by the caller, then "Custom dates".
 * `seasons` comes from `GET time-clock/seasons`.
 */
export function PeriodPicker({
  seasons,
  period,
  onChange,
  className,
}: {
  seasons: import('../../lib/api.types').Season[];
  period: Period | null;
  onChange: (p: Period) => void;
  className: string;
}) {
  const value = period?.kind === 'season' ? String(period.startYear) : 'custom';
  return (
    <>
      <label className="sr-only" htmlFor="period">Season</label>
      <select
        id="period"
        className={className}
        value={value}
        onChange={(e) =>
          onChange(e.target.value === 'custom'
            ? { kind: 'custom', from: '', to: '' }
            : { kind: 'season', startYear: Number(e.target.value) })}
      >
        {seasons.map((s) => <option key={s.startYear} value={s.startYear}>{s.label} season</option>)}
        <option value="custom">Custom dates</option>
      </select>
      {period?.kind === 'custom' && (
        <>
          <label className="sr-only" htmlFor="period-from">From</label>
          <input id="period-from" type="date" className={className} value={period.from}
            onChange={(e) => onChange({ ...period, from: e.target.value })} />
          <label className="sr-only" htmlFor="period-to">To</label>
          <input id="period-to" type="date" className={className} value={period.to}
            onChange={(e) => onChange({ ...period, to: e.target.value })} />
        </>
      )}
    </>
  );
}
