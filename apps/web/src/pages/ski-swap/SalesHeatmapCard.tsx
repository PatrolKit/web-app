import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { HeatmapGrid, dayLabel, hourLabel } from './heatmapParts';
import { money, salesView, type SalesKind } from './salesHeatmap';

/** The Items tile's Sold green, so the two heat maps read as different things. */
const RGB = '34, 197, 94';

/**
 * Sales by hour (Plan 46): days across, hours down, each cell as solid as it
 * was busy. Items sold or dollars taken, from Square's sales: the same read
 * as the Items tile, at most every two minutes, and only this swap's items.
 */
export default function SalesHeatmapCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const [kind, setKind] = useState<SalesKind>('items');
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/sales-heatmap', orgId, swapId],
    queryFn: () => api.skiSwap.getSalesHeatmap(orgId, swapId),
    refetchInterval: 2 * 60_000,
  });
  const failed = (error as Error | null)?.message ?? data?.error ?? null;
  const view = useMemo(() => (data && !data.error ? salesView(data, kind) : null), [data, kind]);
  const units = (n: number) => n.toLocaleString('en-US');
  const format = kind === 'items' ? units : (n: number) => money(n);

  return (
    // A column, so an empty state can take the height the row gives it.
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4 flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Sales by hour</p>
        <div className="flex rounded border border-gray-700 overflow-hidden text-xs" role="tablist" aria-label="Count">
          {(['items', 'dollars'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
              className={`px-3 py-1 ${kind === k ? 'bg-green-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {k === 'items' ? 'Items' : 'Dollars'}
            </button>
          ))}
        </div>
      </div>

      {data && !data.error && (
        <p className="text-xs text-gray-500 mb-3">
          {units(data.totals.units)} sold · {money(data.totals.cents, true)} taken · from Square as of{' '}
          {new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </p>
      )}

      {isLoading && <p className="text-sm text-gray-500">Reading sales from Square…</p>}
      {failed && <p className="text-sm text-amber-400">Couldn’t read sales from Square: {failed}</p>}
      {/* Centered in what's left of the card: beside Check-ins by hour it's as tall as that. */}
      {data && !data.error && data.days.length === 0 && (
        <div className="flex-1 min-h-24 flex items-center justify-center">
          <p className="text-sm text-gray-500">No sales yet.</p>
        </div>
      )}

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
          format={format}
          tip={(d, h, v) => `${dayLabel(d)}, ${hourLabel(h)}: ${kind === 'items' ? `${units(v)} sold` : `${money(v, true)} taken`}`}
          caption={kind === 'items' ? 'Items sold each hour' : 'Dollars taken each hour, after discounts and refunds'}
        />
      )}
    </div>
  );
}
