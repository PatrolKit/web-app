import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { PIE, percent, pieSlices } from './itemsPie';

/**
 * Every item in the swap as one donut: sold, for sale, no price or
 * description, not on sale yet. Each slice carries its number, the middle the
 * total. "Sold" is Square's sales, which the server reads at most every two
 * minutes; the time of that read is shown.
 */
export default function ItemsPieCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/breakdown', orgId, swapId],
    queryFn: () => api.skiSwap.getItemBreakdown(orgId, swapId),
    refetchInterval: 2 * 60_000,
  });

  const failed = (error as Error | null)?.message ?? data?.error ?? null;
  const slices = data && !data.error ? pieSlices(data) : [];
  const c = PIE.size / 2;

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Items</p>
        {data && !data.error && (
          <p className="text-xs text-gray-500">
            Sales from Square as of {new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
        )}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Reading sales from Square…</p>}
      {failed && <p className="text-sm text-amber-400">Couldn’t read sales from Square: {failed}</p>}

      {data && !data.error && (
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <svg viewBox={`0 0 ${PIE.size} ${PIE.size}`} className="w-44 h-44 shrink-0" role="img"
            aria-label={slices.map((s) => `${s.label}: ${s.count}`).join(', ') + `. ${data.total} items in all.`}>
            {data.total === 0 && (
              <circle cx={c} cy={c} r={(PIE.outer + PIE.inner) / 2} strokeWidth={PIE.outer - PIE.inner}
                className="fill-none stroke-gray-800" />
            )}
            {slices.map((s) => s.path && (
              <path key={s.key} d={s.path} className={`${s.fill} stroke-surface-50`} strokeWidth={1.5} />
            ))}
            {slices.map((s) => s.labelAt && (
              <text key={s.key} x={s.labelAt.x} y={s.labelAt.y} textAnchor="middle" dominantBaseline="central"
                className="fill-gray-950 text-[11px] font-semibold">
                {s.count.toLocaleString('en-US')}
              </text>
            ))}
            <text x={c} y={c - 6} textAnchor="middle" dominantBaseline="central" className="fill-white text-[22px] font-bold">
              {data.total.toLocaleString('en-US')}
            </text>
            <text x={c} y={c + 16} textAnchor="middle" dominantBaseline="central" className="fill-gray-400 text-[10px]">
              items
            </text>
          </svg>

          <ul className="space-y-2 text-sm w-full">
            {slices.map((s) => (
              <li key={s.key} className={`flex items-center justify-between gap-4 ${s.count ? '' : 'opacity-50'}`}>
                <span className="flex items-center gap-2 text-gray-300">
                  <span className={`h-3 w-3 rounded-sm ${s.dot}`} aria-hidden="true" />
                  {s.label}
                </span>
                <span className="text-white font-medium tabular-nums">
                  {s.count.toLocaleString('en-US')}
                  <span className="text-gray-500 font-normal ml-2">{percent(s.count, data.total)}</span>
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-4 border-t border-gray-800 pt-2">
              <span className="text-gray-400">Total</span>
              <span className="text-white font-semibold tabular-nums">{data.total.toLocaleString('en-US')}</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
