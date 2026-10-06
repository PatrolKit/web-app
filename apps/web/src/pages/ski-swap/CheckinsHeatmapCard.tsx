import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { dayLabel, heatView, hourLabel, opacity, type HeatKind, type Shown } from './checkinsHeatmap';

/** The cells' color; opacity carries the count. */
const RGB = '56, 138, 221';

const KINDS = [
  { key: 'individual', label: 'Individuals' },
  { key: 'business', label: 'Businesses' },
] as const;

/**
 * Check-ins by hour: days across, hours down, each cell's color as solid as
 * its count is high. Items or sellers (each seller counted once however hours
 * are added up), for individuals, businesses or both. Totals per day along
 * the top and per hour down the right. Issued tickets count when issued, when
 * their items were made.
 */
export default function CheckinsHeatmapCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const [kind, setKind] = useState<HeatKind>('items');
  const [shown, setShown] = useState<Shown>({ individual: true, business: true });
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/checkins', orgId, swapId],
    queryFn: () => api.skiSwap.getCheckinsHeatmap(orgId, swapId),
    // Our own rows, and check-in moves them: once a minute, like the tiles.
    refetchInterval: 60_000,
  });
  const view = useMemo(() => (data ? heatView(data, kind, shown) : null), [data, kind, shown]);
  const fmt = (n: number) => n.toLocaleString('en-US');

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Check-ins by hour</p>
        <div className="flex rounded border border-gray-700 overflow-hidden text-xs" role="tablist" aria-label="Count">
          {(['items', 'sellers'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
              className={`px-3 py-1 ${kind === k ? 'bg-sky-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {k === 'items' ? 'Items' : 'Sellers'}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2 mb-3" role="group" aria-label="Show">
        {KINDS.map((k) => (
          <button key={k.key} type="button" aria-pressed={shown[k.key]}
            onClick={() => setShown((s) => ({ ...s, [k.key]: !s[k.key] }))}
            className={`px-2.5 py-0.5 rounded-full text-xs border ${shown[k.key] ? 'border-gray-600 text-gray-200' : 'border-gray-800 text-gray-500 line-through'}`}>
            {k.label} <span className="tabular-nums text-gray-500">{view ? fmt(view.kindTotals[k.key]) : ''}</span>
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-amber-400">Couldn’t load check-ins: {(error as Error).message}</p>}
      {data && data.days.length === 0 && <p className="text-sm text-gray-500">No check-ins yet.</p>}

      {data && view && data.days.length > 0 && (
        <>
          <div className="overflow-x-auto">
            <div
              className="grid gap-[3px] items-center text-xs min-w-max"
              style={{ gridTemplateColumns: `3.25rem repeat(${data.days.length}, minmax(2.75rem, 1fr)) 2.75rem` }}
            >
              <div />
              {data.days.map((d) => (
                <div key={d} className="text-center text-[11px] text-gray-500 tabular-nums">{fmt(view.dayTotal(d))}</div>
              ))}
              <div className="text-center text-[11px] text-gray-500">all</div>

              {data.hours.map((h) => (
                <Row key={h}>
                  <div className="text-right pr-2 text-[11px] text-gray-500 whitespace-nowrap">{hourLabel(h)}</div>
                  {data.days.map((d) => {
                    const v = view.value(d, h);
                    const a = opacity(v, view.max);
                    return (
                      <div key={d} title={`${dayLabel(d)}, ${hourLabel(h)}: ${fmt(v)} ${kind}`}
                        className={`h-7 rounded flex items-center justify-center tabular-nums ${v ? '' : 'bg-surface-100'} ${a > 0.55 ? 'text-white' : 'text-gray-300'}`}
                        style={v ? { backgroundColor: `rgba(${RGB}, ${a})` } : undefined}>
                        {v ? fmt(v) : ''}
                      </div>
                    );
                  })}
                  <div className="text-center text-[11px] text-gray-500 tabular-nums">{fmt(view.hourTotal(h))}</div>
                </Row>
              ))}

              <div />
              {data.days.map((d) => (
                <div key={d} className="text-center text-[11px] text-gray-500 pt-1 whitespace-nowrap">{dayLabel(d)}</div>
              ))}
              <div className="text-center text-[11px] text-gray-300 pt-1 tabular-nums">{fmt(view.total)}</div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 mt-3 text-[11px] text-gray-500">
            <span>Fewer</span>
            <span className="flex gap-0.5" aria-hidden="true">
              {[0.12, 0.35, 0.6, 0.85, 1].map((o) => (
                <span key={o} className="w-4 h-2.5 rounded-sm" style={{ backgroundColor: `rgba(${RGB}, ${o})` }} />
              ))}
            </span>
            <span>More</span>
            <span className="ml-auto">
              {kind === 'items' ? 'Items checked in each hour' : 'Different sellers who checked in each hour'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** A grid row is just its cells: the grid lays them out. */
function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
