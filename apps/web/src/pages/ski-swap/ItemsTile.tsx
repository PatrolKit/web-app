import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { itemSegments, percent } from './itemsPie';

/**
 * Every item in the swap as one short stacked bar (Plan 46 D3), the Sellers
 * tile's shape: sold, returned, for sale, no price, no description, not on
 * sale. "Sold" is Square's sales, which the server reads at most every two
 * minutes; the time of that read is shown.
 */
export default function ItemsTile({ orgId, swapId }: { orgId: string; swapId: string }) {
  const { data, error } = useQuery({
    queryKey: ['ski-swap/stats/breakdown', orgId, swapId],
    queryFn: () => api.skiSwap.getItemBreakdown(orgId, swapId),
    refetchInterval: 2 * 60_000,
  });
  const failed = (error as Error | null)?.message ?? data?.error ?? null;
  const ok = data && !data.error;
  const segments = ok ? itemSegments(data) : [];
  const fmt = (n: number) => n.toLocaleString('en-US');

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">Items</p>
      <p className="text-2xl font-bold text-white">{ok ? fmt(data.total) : '—'}</p>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-gray-800 mt-3 mb-2" role="img"
        aria-label={ok ? segments.filter((s) => s.count).map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', ') : 'Loading'}>
        {segments.map((s) => s.count > 0 && (
          <div key={s.key} className={s.dot} style={{ width: s.width }} title={`${s.label}: ${fmt(s.count)} (${percent(s.count, data!.total)})`} />
        ))}
      </div>
      {ok && (
        <p className="text-xs text-gray-400 flex flex-wrap gap-x-3 gap-y-0.5">
          {segments.filter((s) => s.count > 0).map((s) => (
            <span key={s.key} className="whitespace-nowrap">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.dot} mr-1.5 align-[-1px]`} />{fmt(s.count)} {s.label.toLowerCase()}
            </span>
          ))}
        </p>
      )}
      {failed
        ? <p className="text-[11px] text-amber-400 mt-1.5">Couldn’t read sales from Square: {failed}</p>
        : ok && (
          <p className="text-[11px] text-gray-500 mt-1.5">
            Sales from Square as of {new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
        )}
    </div>
  );
}
