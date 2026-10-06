import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { NodeIcon } from '../../components/ItemDescriber';
import type { ResolvedTaxonomy } from '../../lib/api.types';

/** The tallest column, in pixels: the card stays short. */
const BAR_MAX = 80;

/**
 * Items per category, busiest first: a short column each, its count on top,
 * and under it the category's icon (the item picker's) and name. Items with
 * no category are only counted, in the header; "Other" isn't shown.
 */
export default function CategoriesChartCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/categories', orgId, swapId],
    queryFn: () => api.skiSwap.getCategoryCounts(orgId, swapId),
    refetchInterval: 60_000,
  });
  // The picker's tree, for each category's icon; the same query, so usually cached.
  const { data: taxonomy } = useQuery<ResolvedTaxonomy>({
    queryKey: ['taxonomy', orgId],
    queryFn: () => api.skiSwap.taxonomy(orgId),
    staleTime: 5 * 60 * 1000,
  });
  const icons = useMemo(() => new Map((taxonomy?.categories ?? []).map((c) => [c.id, c.icon])), [taxonomy]);

  const categories = data?.categories ?? [];
  const max = Math.max(1, ...categories.map((c) => c.count));
  const shown = categories.reduce((n, c) => n + c.count, 0);
  const fmt = (n: number) => n.toLocaleString('en-US');

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Items by category</p>
        {data && (
          <p className="text-xs text-gray-500">
            {fmt(shown)} in these categories · {fmt(data.uncategorised)} without a category
          </p>
        )}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-amber-400">Couldn’t load categories: {(error as Error).message}</p>}
      {data && categories.length === 0 && <p className="text-sm text-gray-500">No items have a category yet.</p>}

      {categories.length > 0 && (
        <div className="overflow-x-auto">
          <div className="flex items-end gap-1.5 min-w-max sm:min-w-0">
            {categories.map((c) => (
              <div key={c.categoryId} className="flex-1 min-w-[3.5rem] flex flex-col items-center" title={`${c.label}: ${fmt(c.count)}`}>
                <span className="text-[11px] text-gray-200 tabular-nums">{fmt(c.count)}</span>
                <div className="w-full max-w-[2.75rem] mt-1 rounded-t bg-teal-500"
                  style={{ height: `${Math.max(3, Math.round((c.count / max) * BAR_MAX))}px` }} />
                <div className="h-6 mt-1.5 flex items-center justify-center text-teal-400">
                  <NodeIcon icon={icons.get(c.categoryId)} className="h-4 w-4" />
                </div>
                <span className="text-[10px] text-gray-400 text-center leading-tight mt-0.5 h-6 line-clamp-2">{c.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
