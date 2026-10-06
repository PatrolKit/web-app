import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { CHART, chartLayout, dayLabel, type Shown } from './checkinsChart';

const KINDS = [
  { key: 'individual', label: 'Individuals', fill: 'fill-sky-500', chip: 'bg-sky-500' },
  { key: 'business', label: 'Businesses', fill: 'fill-violet-500', chip: 'bg-violet-500' },
] as const;

/**
 * Items checked in per day, from the first day with any to the last, empty
 * days kept as spaces. Stacked: individuals under businesses, each hidden by
 * its toggle; the day's total sits above its bar. Issued tickets count on the
 * day they were issued, when their items were made.
 */
export default function CheckinsChartCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const [shown, setShown] = useState<Shown>({ individual: true, business: true });
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/checkins', orgId, swapId],
    queryFn: () => api.skiSwap.getCheckinsPerDay(orgId, swapId),
    // Our own rows, and check-in moves them: once a minute, like the tiles.
    refetchInterval: 60_000,
  });

  // The card's width, so a short swap's days spread across it.
  const box = useRef<HTMLDivElement>(null);
  const [fitWidth, setFitWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setFitWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const days = useMemo(() => data?.days ?? [], [data]);
  const layout = useMemo(() => chartLayout(days, shown, fitWidth || undefined), [days, shown, fitWidth]);
  const sums = useMemo(() => ({
    individual: days.reduce((n, d) => n + d.individual, 0),
    business: days.reduce((n, d) => n + d.business, 0),
  }), [days]);

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Check-ins per day</p>
        <div className="flex gap-2" role="group" aria-label="Show">
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={shown[k.key]}
              onClick={() => setShown((s) => ({ ...s, [k.key]: !s[k.key] }))}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border ${
                shown[k.key] ? 'border-gray-600 text-gray-200' : 'border-gray-800 text-gray-500'
              }`}
            >
              <span className={`h-2.5 w-2.5 rounded-sm ${shown[k.key] ? k.chip : 'bg-gray-700'}`} aria-hidden="true" />
              {k.label}
              <span className="tabular-nums text-gray-500">{sums[k.key].toLocaleString('en-US')}</span>
            </button>
          ))}
        </div>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-amber-400">Couldn’t load check-ins: {(error as Error).message}</p>}
      {data && days.length === 0 && <p className="text-sm text-gray-500">No check-ins yet.</p>}

      <div ref={box} className="overflow-x-auto">
        {days.length > 0 && (
          <svg
            width={layout.width} height={CHART.height} viewBox={`0 0 ${layout.width} ${CHART.height}`}
            className="block" role="img"
            aria-label={`Check-ins per day, ${dayLabel(days[0].date)} to ${dayLabel(days[days.length - 1].date)}`}
          >
            {layout.ticks.map((t) => (
              <g key={t}>
                <line x1={CHART.left} x2={layout.width} y1={layout.tickY(t)} y2={layout.tickY(t)} className="stroke-gray-800" />
                <text x={CHART.left - 6} y={layout.tickY(t)} textAnchor="end" dominantBaseline="central" className="fill-gray-500 text-[10px]">
                  {Number.isInteger(t) ? t.toLocaleString('en-US') : t.toFixed(1)}
                </text>
              </g>
            ))}
            {layout.bars.map((b) => (
              <g key={b.date}>
                <title>
                  {`${dayLabel(b.date)}: ${b.total.toLocaleString('en-US')} checked in`
                    + b.segments.map((s) => `\n${s.kind === 'individual' ? 'Individuals' : 'Businesses'}: ${s.count.toLocaleString('en-US')}`).join('')}
                </title>
                {/* The whole slot, so a hover anywhere in the day finds it. */}
                <rect x={b.x} y={CHART.top} width={b.width} height={layout.baseline - CHART.top} className="fill-transparent" />
                {b.segments.map((s) => (
                  <rect key={s.kind} x={b.x} y={s.y} width={b.width} height={Math.max(s.height, 1)}
                    className={KINDS.find((k) => k.key === s.kind)!.fill} />
                ))}
                {b.total > 0 && (
                  <text x={b.x + b.width / 2} y={(b.segments.at(-1)?.y ?? layout.baseline) - 4} textAnchor="middle"
                    className="fill-gray-300 text-[10px] font-medium">
                    {b.total.toLocaleString('en-US')}
                  </text>
                )}
                {b.label && (
                  <text x={b.x + b.width / 2} y={CHART.height - 6} textAnchor="middle" className="fill-gray-500 text-[10px]">
                    {b.label}
                  </text>
                )}
              </g>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
