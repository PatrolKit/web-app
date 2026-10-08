import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { heatView, type HeatKind, type Shown } from './checkinsHeatmap';
import { HeatmapGrid, dayLabel, hourLabel } from './heatmapParts';

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
        <HeatmapGrid
          days={data.days}
          hours={data.hours}
          rgb={RGB}
          value={view.value}
          dayTotal={view.dayTotal}
          hourTotal={view.hourTotal}
          total={view.total}
          max={view.max}
          format={fmt}
          tip={(d, h, v) => `${dayLabel(d)}, ${hourLabel(h)}: ${fmt(v)} ${kind}`}
          caption={kind === 'items' ? 'Items checked in each hour' : 'Different sellers who checked in each hour'}
        />
      )}
    </div>
  );
}

