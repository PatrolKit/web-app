import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type {
  HealthPlace, HealthRange, LimitKeyedBy, LimitSeries, LimitSummary,
} from '../../lib/api.types';

const RANGES: { value: HealthRange; label: string }[] = [
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
];

const KEYED_BY: Record<LimitKeyedBy, string> = {
  ip: 'IP address',
  caller: 'Account or device',
  destination: 'Phone or email',
  site: 'Whole site',
};

/**
 * Every limit on the server, and how close real traffic has come to each
 * (Plan 26 §11).
 *
 * The half-limit warning in the log is the moment; this is the record. Sorted by
 * peak so the one worth looking at is at the top, and refusals are the loudest
 * thing here whatever the peak says: a refusal is somebody real told no.
 */
export default function ServerHealthTab() {
  const [range, setRange] = useState<HealthRange>('24h');
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-health-limits', range],
    queryFn: () => api.admin.healthLimits(range),
    // The server merges in the minute it has not written yet, so this is live.
    refetchInterval: 60_000,
  });

  const limits = [...(data?.limits ?? [])].sort(
    (a, b) => (b.peak?.percent ?? -1) - (a.peak?.percent ?? -1) || b.refusedCount - a.refusedCount,
  );
  const quiet = limits.every((l) => l.peak === null);
  const refused = limits.reduce((n, l) => n + l.refusedCount, 0);

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-white font-medium">Server health</h2>
        <p className="text-xs text-gray-500">
          Every limit on the server, and the closest any one person, device, address or
          destination has come to it. Counts only — nothing here says who.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex gap-1 p-1 bg-surface-100 rounded-lg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              onClick={() => { setRange(r.value); setOpen(null); }}
              className={[
                'px-3 py-1 rounded-md text-sm',
                range === r.value ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
              ].join(' ')}
            >
              {r.label}
            </button>
          ))}
        </div>
        {refused > 0 && (
          <span className="text-sm font-medium text-red-400">
            {refused.toLocaleString()} {refused === 1 ? 'request' : 'requests'} refused in this range
          </span>
        )}
      </div>

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : error ? (
        <p className="text-red-400 text-sm">{(error as Error).message}</p>
      ) : (
        <>
          {quiet && (
            <p className="text-sm text-gray-400 bg-surface-50 rounded-lg p-4">
              No traffic recorded in this range.
            </p>
          )}
          <div className="bg-surface-50 rounded-lg overflow-x-auto">
            <table className="w-full text-sm min-w-[44rem]">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
                  <th className="px-4 py-2 font-normal">Limit</th>
                  <th className="px-4 py-2 font-normal">Counted per</th>
                  <th className="px-4 py-2 font-normal w-48">Peak</th>
                  <th className="px-4 py-2 font-normal">When and where</th>
                  <th className="px-4 py-2 font-normal text-right" title="How many keys crossed half the limit">
                    Past half
                  </th>
                  <th className="px-4 py-2 font-normal text-right">Refused</th>
                </tr>
              </thead>
              <tbody>
                {limits.map((l) => (
                  <Fragment key={l.id}>
                    <LimitRow limit={l} open={open === l.id} onToggle={() => setOpen(open === l.id ? null : l.id)} />
                    {open === l.id && (
                      <tr className="border-b border-gray-800">
                        <td colSpan={6} className="px-4 py-4 bg-surface-100/40">
                          <LimitDetail limitId={l.id} range={range} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function LimitRow({ limit: l, open, onToggle }: { limit: LimitSummary; open: boolean; onToggle: () => void }) {
  return (
    <tr
      onClick={onToggle}
      aria-expanded={open}
      className={[
        'border-b border-gray-800 cursor-pointer hover:bg-surface-100/60',
        l.refusedCount > 0 ? 'bg-red-950/30' : '',
      ].join(' ')}
    >
      <td className="px-4 py-3">
        <p className="text-white">{l.label}</p>
        <p className="text-xs text-gray-500">
          {l.limit.toLocaleString()} {perWindow(l.windowSeconds)}
        </p>
      </td>
      <td className="px-4 py-3 text-gray-400">{KEYED_BY[l.keyedBy]}</td>
      <td className="px-4 py-3">
        {l.peak ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-surface-200 overflow-hidden">
              <div className={`h-full ${barColor(l.peak.percent)}`} style={{ width: `${Math.max(2, l.peak.percent)}%` }} />
            </div>
            <span className="text-gray-300 tabular-nums w-12 text-right">{l.peak.percent}%</span>
          </div>
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-gray-400">
        {l.peak ? (
          <>
            <p>{formatHour(l.peak.hourStart)}</p>
            <p className="text-xs text-gray-500">{placeName(l.peak)}</p>
          </>
        ) : (
          <span className="text-gray-600">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-gray-400">{l.nearCount || '—'}</td>
      <td
        className={[
          'px-4 py-3 text-right tabular-nums',
          l.refusedCount > 0 ? 'text-red-400 font-semibold' : 'text-gray-600',
        ].join(' ')}
      >
        {l.refusedCount > 0 ? l.refusedCount.toLocaleString() : '—'}
      </td>
    </tr>
  );
}

function LimitDetail({ limitId, range }: { limitId: string; range: HealthRange }) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin-health-series', limitId, range],
    queryFn: () => api.admin.healthLimitSeries(limitId, range),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <PeakChart series={data} />
      <div>
        <p className="text-xs text-gray-500 mb-1">Closest in this range</p>
        {data.top.length === 0 ? (
          <p className="text-sm text-gray-400">No traffic recorded in this range.</p>
        ) : (
          <ul className="space-y-1">
            {data.top.map((p, i) => (
              <li key={i} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-gray-300 truncate">{placeName(p)}</span>
                <span className="shrink-0 tabular-nums text-gray-400">
                  {p.percent}%
                  {p.refusedCount > 0 && (
                    <span className="ml-3 text-red-400 font-semibold">{p.refusedCount} refused</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const W = 600;
const H = 160;
const PAD = { top: 10, right: 8, bottom: 22, left: 36 };

/**
 * The peak over the range, with lines at half and at the limit.
 *
 * Drawn by hand: one chart shape with two reference lines does not justify a
 * charting library, and the web app has none.
 */
function PeakChart({ series }: { series: LimitSeries }) {
  const n = series.points.length;
  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.left - PAD.right));
  const y = (pct: number) => PAD.top + (1 - Math.min(pct, 100) / 100) * (H - PAD.top - PAD.bottom);

  // Broken where nothing was counted, rather than drawn down to zero: a gap is
  // "no traffic", and a line through zero would say "traffic, and all fine".
  const segments: string[] = [];
  let current = '';
  series.points.forEach((p, i) => {
    if (p.percent === null) {
      if (current) segments.push(current);
      current = '';
      return;
    }
    current += `${current ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.percent).toFixed(1)}`;
  });
  if (current) segments.push(current);

  const labels = n > 0 ? [0, Math.floor((n - 1) / 2), n - 1] : [];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40" role="img" aria-label="Peak percentage over time">
      {[0, 50, 100].map((pct) => (
        <g key={pct}>
          <line
            x1={PAD.left} x2={W - PAD.right} y1={y(pct)} y2={y(pct)}
            className={pct === 100 ? 'stroke-red-500/60' : pct === 50 ? 'stroke-amber-500/60' : 'stroke-gray-700'}
            strokeDasharray={pct === 0 ? undefined : '4 4'}
          />
          <text x={PAD.left - 6} y={y(pct) + 4} textAnchor="end" className="fill-gray-500 text-[10px]">
            {pct}%
          </text>
        </g>
      ))}
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" className="stroke-brand-500" strokeWidth={2} strokeLinejoin="round" />
      ))}
      {series.points.map((p, i) =>
        p.percent !== null && (p.refusedCount > 0 || segmentIsDot(series.points, i)) ? (
          <circle
            key={i}
            cx={x(i)} cy={y(p.percent)} r={p.refusedCount > 0 ? 4 : 2.5}
            className={p.refusedCount > 0 ? 'fill-red-500' : 'fill-brand-500'}
          >
            <title>{`${formatBucket(p.at, series.bucket)}: ${p.percent}%${p.refusedCount ? `, ${p.refusedCount} refused` : ''}`}</title>
          </circle>
        ) : null,
      )}
      {labels.map((i) => (
        <text
          key={i}
          x={x(i)} y={H - 6}
          textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
          className="fill-gray-500 text-[10px]"
        >
          {formatBucket(series.points[i].at, series.bucket)}
        </text>
      ))}
    </svg>
  );
}

/** A point with no neighbour to draw a line to would otherwise be invisible. */
function segmentIsDot(points: LimitSeries['points'], i: number): boolean {
  return (points[i - 1]?.percent ?? null) === null && (points[i + 1]?.percent ?? null) === null;
}

function barColor(percent: number): string {
  if (percent > 80) return 'bg-red-500';
  if (percent >= 50) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function perWindow(seconds: number): string {
  if (seconds === 60) return 'per minute';
  if (seconds === 3600) return 'per hour';
  if (seconds === 86_400) return 'per day';
  if (seconds % 60 === 0) return `per ${seconds / 60} minutes`;
  return `per ${seconds} seconds`;
}

function placeName(p: HealthPlace): string {
  if (p.org && p.swap) return `${p.org.name} · ${p.swap.title}`;
  if (p.org) return p.org.name;
  return 'Platform-wide';
}

function formatHour(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
}

function formatBucket(iso: string, bucket: 'hour' | 'day'): string {
  return bucket === 'hour'
    ? formatHour(iso)
    : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
