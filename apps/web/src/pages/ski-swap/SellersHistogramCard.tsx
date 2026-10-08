import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { histogram, median, sum } from './histogram';
import { HistogramBars, Toggle } from './histogramParts';
import { money } from './salesHeatmap';

type Who = 'individual' | 'business';
type Measure = 'items' | 'listed' | 'sold';

/**
 * Per seller: how many sellers brought how many items, or how many dollars'
 * worth (listed: asking prices; sold: what the register took, from Square).
 * Individuals and businesses apart, since a shop brings hundreds.
 */
export default function SellersHistogramCard({ orgId, swapId }: { orgId: string; swapId: string }) {
  const [who, setWho] = useState<Who>('individual');
  const [measure, setMeasure] = useState<Measure>('items');
  const { data, error, isLoading } = useQuery({
    queryKey: ['ski-swap/stats/seller-totals', orgId, swapId],
    queryFn: () => api.skiSwap.getSellerTotals(orgId, swapId),
    refetchInterval: 2 * 60_000,
  });

  const sellers = useMemo(() => (data?.sellers ?? []).filter((s) => s.business === (who === 'business')), [data, who]);
  const counts = { individual: 0, business: 0 };
  for (const s of data?.sellers ?? []) counts[s.business ? 'business' : 'individual'] += 1;

  const soldUnknown = measure === 'sold' && !!data?.error;
  const values = useMemo(() => {
    if (measure === 'items') return sellers.filter((s) => s.items > 0).map((s) => s.items);
    if (measure === 'listed') return sellers.filter((s) => s.items > 0).map((s) => s.listedCents);
    return sellers.flatMap((s) => (s.soldCents === null ? [] : [s.soldCents]));
  }, [sellers, measure]);
  const bins = useMemo(() => histogram(values, measure === 'items' ? 'items' : 'cents'), [values, measure]);

  const fmt = (n: number) => n.toLocaleString('en-US');
  const people = who === 'business' ? (values.length === 1 ? 'business' : 'businesses') : (values.length === 1 ? 'individual seller' : 'individual sellers');
  const summary =
    measure === 'items' ? `${fmt(values.length)} ${people} · ${fmt(sum(values))} items · median ${fmt(median(values))}`
    : measure === 'listed' ? `${fmt(values.length)} ${people} · ${money(sum(values))} listed · median ${money(median(values))}`
    : `${fmt(values.length)} ${people} · ${money(sum(values))} sold · median ${money(median(values))}`;
  const caption =
    measure === 'items' ? 'Sellers by how many priced items they brought'
    : measure === 'listed' ? 'Sellers by the asking prices of their items, added up'
    : 'Sellers by what the register took for their items, after discounts and refunds';

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4 flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <p className="text-gray-400 text-xs uppercase tracking-wide">Per seller</p>
        <div className="flex flex-wrap gap-2">
          <Toggle label="Sellers" value={who} onChange={setWho} activeClass="bg-violet-600"
            options={[{ value: 'individual', label: `Individuals ${fmt(counts.individual)}` }, { value: 'business', label: `Businesses ${fmt(counts.business)}` }]} />
          <Toggle label="Measure" value={measure} onChange={setMeasure} activeClass="bg-violet-600"
            options={[{ value: 'items', label: 'Items' }, { value: 'listed', label: 'Listed $' }, { value: 'sold', label: 'Sold $' }]} />
        </div>
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-amber-400">Couldn’t load sellers: {(error as Error).message}</p>}
      {soldUnknown && <p className="text-sm text-amber-400">Couldn’t read sales from Square: {data!.error}</p>}

      {data && !soldUnknown && (
        <>
          <p className="text-xs text-gray-500 mb-3">{summary}</p>
          {bins.length === 0 ? (
            <div className="flex-1 min-h-24 flex items-center justify-center">
              <p className="text-sm text-gray-500">{who === 'business' ? 'No businesses' : 'No individual sellers'} with items yet.</p>
            </div>
          ) : (
            <>
              <HistogramBars bins={bins} barClass="bg-violet-500" noun={who === 'business' ? 'businesses' : 'sellers'} />
              <p className="mt-2 text-[11px] text-gray-500">{caption}</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
