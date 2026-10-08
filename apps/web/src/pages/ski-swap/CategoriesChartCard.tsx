import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { NodeIcon } from '../../components/ItemDescriber';
import type { ResolvedTaxonomy } from '../../lib/api.types';

import { columns, sums } from './categoriesChart';

/** The tallest column, in pixels: the card stays short. */
const BAR_MAX = 80;

/**
 * Units per category, busiest first: a short column each, and inside it,
 * from the bottom, the part that has sold (Plan 46 D6), with "sold / total"
 * on top; under it the category's icon (the item picker's) and name. Items
 * with no category are only counted, in the header; "Other" isn't shown.
 *
 * The counts are our own rows and come first; sold is Square's sales, read
 * at most every two minutes, and follows. Without it the columns still draw.
 */
export default function CategoriesChartCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/categories', orgId, swapId],
    queryFn: () => api.skiSwap.getCategoryCounts(orgId, swapId),
    refetchInterval: 60_000,
  });
  const { data: soldData, error: soldError } = useQuery({
    queryKey: ['ski-swap/stats/sold-by-category', orgId, swapId],
    queryFn: () => api.skiSwap.getSoldByCategory(orgId, swapId),
    refetchInterval: 2 * 60_000,
  });
  // The picker's tree, for each category's icon; the same query, so usually cached.
  const { data: taxonomy } = useQuery<ResolvedTaxonomy>({
    queryKey: ['taxonomy', orgId],
    queryFn: () => api.skiSwap.taxonomy(orgId),
    staleTime: 5 * 60 * 1000,
  });
  const icons = useMemo(() => new Map((taxonomy?.categories ?? []).map((c) => [c.id, c.icon])), [taxonomy]);

  const soldFailed = (soldError as Error | null)?.message ?? soldData?.error ?? null;
  const cols = useMemo(
    () => columns(data?.categories ?? [], soldData && !soldData.error ? soldData.categories : null),
    [data, soldData],
  );
  const max = Math.max(1, ...cols.map((c) => c.total));
  const sum = sums(cols);
  const fmt = (n: number) => n.toLocaleString('en-US');
  const height = (n: number) => Math.max(3, Math.round((n / max) * BAR_MAX));

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Items by category</p>
        {data && (
          <p className="text-xs text-gray-500">
            {sum.sold !== null ? `${fmt(sum.sold)} sold of ` : ''}{fmt(sum.total)} in these categories · {fmt(data.uncategorised)} without a category
            {soldFailed ? <span className="text-amber-400"> · couldn’t read sales from Square</span> : null}
          </p>
        )}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-amber-400">Couldn’t load categories: {(error as Error).message}</p>}
      {data && cols.length === 0 && <p className="text-sm text-gray-500">No items have a category yet.</p>}

      {cols.length > 0 && (
        <div className="overflow-x-auto">
          <div className="flex items-end gap-1.5 min-w-max sm:min-w-0">
            {cols.map((c) => (
              <div key={c.categoryId} className="flex-1 min-w-[3.5rem] flex flex-col items-center"
                title={c.sold !== null
                  ? `${c.label}: ${fmt(c.sold)} of ${fmt(c.total)} sold (${c.total ? Math.round((c.sold / c.total) * 100) : 0}%)`
                  : `${c.label}: ${fmt(c.total)}`}>
                <span className="text-[11px] text-gray-200 tabular-nums whitespace-nowrap">
                  {c.sold !== null ? <><span className="text-teal-300">{fmt(c.sold)}</span><span className="text-gray-500"> / </span></> : null}
                  {fmt(c.total)}
                </span>
                {/* The column is the total, a tint; the sold part fills it from the bottom. */}
                <div className="w-full max-w-[2.75rem] mt-1 rounded-t bg-teal-500/30 flex flex-col justify-end overflow-hidden"
                  style={{ height: `${height(c.total)}px` }}>
                  {c.sold ? <div className="w-full bg-teal-500" style={{ height: `${(c.sold / c.total) * 100}%` }} /> : null}
                </div>
                <div className="h-6 mt-1.5 flex items-center justify-center text-teal-400">
                  <NodeIcon icon={icons.get(c.categoryId)} className="h-4 w-4" />
                </div>
                <span className="text-[10px] text-gray-400 text-center leading-tight mt-0.5 h-6 line-clamp-2">{c.label}</span>
              </div>
            ))}
          </div>
          {sum.sold !== null && (
            <p className="flex gap-4 mt-2 text-[11px] text-gray-500">
              <span><span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500 mr-1.5 align-[-1px]" />Sold</span>
              <span><span className="inline-block h-2.5 w-2.5 rounded-sm bg-teal-500/30 mr-1.5 align-[-1px]" />Not sold</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
