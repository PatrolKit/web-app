import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { histogram, median, sum } from './histogram';
import { HistogramBars, Toggle } from './histogramParts';
import { money } from './salesHeatmap';

/**
 * Per buyer: how many checkouts took how many items, or how many dollars.
 * Square can't say who a buyer was, so each checkout counts as one; someone
 * who checks out twice counts twice. The same Square read as Sales by hour.
 */
export default function BuyersHistogramCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const [measure, setMeasure] = useState<'items' | 'dollars'>('items');
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/checkout-totals', orgId, swapId],
    queryFn: () => api.skiSwap.getCheckoutTotals(orgId, swapId),
    refetchInterval: 2 * 60_000,
  });
  const failed = (error as Error | null)?.message ?? data?.error ?? null;

  const values = useMemo(
    () => (data?.checkouts ?? []).map((c) => (measure === 'items' ? c.units : c.cents)),
    [data, measure],
  );
  const bins = useMemo(() => histogram(values, measure === 'items' ? 'items' : 'cents'), [values, measure]);
  const fmt = (n: number) => n.toLocaleString('en-US');
  const n = values.length;
  const summary = measure === 'items'
    ? `${fmt(n)} ${n === 1 ? 'checkout' : 'checkouts'} · ${fmt(sum(values))} items · median ${fmt(median(values))}`
    : `${fmt(n)} ${n === 1 ? 'checkout' : 'checkouts'} · ${money(sum(values))} taken · median ${money(median(values))}`;

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4 flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Per buyer</p>
        <Toggle label="Measure" value={measure} onChange={setMeasure} activeClass="bg-green-600"
          options={[{ value: 'items', label: 'Items' }, { value: 'dollars', label: 'Dollars' }]} />
      </div>

      {isLoading && <p className="text-sm text-gray-500">Reading sales from Square…</p>}
      {failed && <p className="text-sm text-amber-400">Couldn’t read sales from Square: {failed}</p>}

      {data && !data.error && (
        <>
          <p className="text-xs text-gray-500 mb-3">
            {summary} · from Square as of {new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
          {bins.length === 0 ? (
            <div className="flex-1 min-h-24 flex items-center justify-center">
              <p className="text-sm text-gray-500">No sales yet.</p>
            </div>
          ) : (
            <>
              <HistogramBars bins={bins} barClass="bg-green-500" noun="checkouts" />
              <p className="mt-2 text-[11px] text-gray-500">
                {measure === 'items' ? 'Checkouts by how many items they took' : 'Checkouts by what the register took, after discounts and refunds'}
                {' '}· each checkout counts as one buyer
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
