import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import type { SkiSwapContext } from './SkiSwapLayout';

function StatTile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
    </div>
  );
}

export default function SkiSwapDashboard() {
  const { orgId, selectedSwap, perms, requireConsignmentScan } = useOutletContext<SkiSwapContext>();

  const { data: stats } = useQuery({
    queryKey: ['ski-swap/stats', orgId, selectedSwap?.id],
    queryFn: () => api.skiSwap.getStats(orgId, selectedSwap!.id),
    enabled: !!selectedSwap,
  });

  // Sellers missing an address or a way to be paid. Invisible until someone
  // tries to act on the gap — a cheque with nowhere to go, an unsold item
  // nobody can return — so it is worth a tile while the swap is still running.
  const { data: unpayable = [] } = useQuery({
    queryKey: ['ski-swap/sellers', orgId, true],
    queryFn: () => api.skiSwap.listSellers(orgId, undefined, true),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  /**
   * How many people are standing next to a pile waiting for a volunteer.
   *
   * Asked for only when the scan is on: with it off every item is consigned at
   * creation, so the answer is always zero and the request buys nothing. One
   * item is fetched because only `total` is read.
   */
  const { data: waiting } = useQuery({
    queryKey: ['ski-swap/items', orgId, selectedSwap?.id, 'awaiting-consignment'],
    queryFn: () => api.skiSwap.listItems(orgId, selectedSwap!.id, { consigned: false, take: 1 }),
    enabled: !!selectedSwap && requireConsignmentScan,
    // Short: this is the number that moves during a swap, and it is read by
    // someone deciding whether to send another volunteer to the tables.
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  if (!selectedSwap) {
    return (
      <p className="text-gray-400 text-sm">
        {perms.has('ski_swap:admin')
          ? "No active swaps found. Create one on the 'Swaps' page."
          : 'No active swaps found. Contact your swap administrator to create one.'}
      </p>
    );
  }

  const revenue = stats ? `$${(stats.grossRevenueCents / 100).toFixed(2)}` : '—';

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatTile label="Total Items" value={stats?.totalItems ?? '—'} />
        <StatTile label="Items Sold" value={stats?.itemsSold ?? '—'} />
        <StatTile label="Sellers" value={stats?.totalSellers ?? '—'} />
        <StatTile label="Est. Revenue" value={revenue} />
      </div>

      {/* Only while there is somebody waiting. Nothing here accepts an item —
          that happens at the table, on the staff iPad — so this says where to
          go rather than pretending to be an action. */}
      {(waiting?.total ?? 0) > 0 && (
        <div className="bg-amber-900/30 border border-amber-800 rounded-lg p-4">
          <p className="text-amber-300 text-sm font-medium">
            {waiting!.total} {waiting!.total === 1 ? 'item is' : 'items are'} waiting to be accepted
          </p>
          <p className="text-xs text-amber-500/80 mt-0.5">
            Their sellers are standing with them. Staff scan each tag at the check-in table.
          </p>
        </div>
      )}

      {/* Shown only when there is something to act on: a zero here is the
          normal state, and a tile reading zero every day stops being read. */}
      {unpayable.length > 0 && (
        <Link
          to="/dashboard/ski-swap/sellers"
          className="block bg-amber-900/30 border border-amber-800 rounded-lg p-4 hover:border-amber-600"
        >
          <p className="text-amber-300 text-sm font-medium">
            {unpayable.length} {unpayable.length === 1 ? 'seller' : 'sellers'} cannot be paid
          </p>
          <p className="text-xs text-amber-500/80 mt-0.5">
            Missing an address or a way to send the money. Fix before the swap closes.
          </p>
        </Link>
      )}
    </div>
  );
}
