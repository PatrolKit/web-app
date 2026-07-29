import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
  const { orgId, selectedSwap, perms } = useOutletContext<SkiSwapContext>();

  const { data: stats } = useQuery({
    queryKey: ['ski-swap/stats', orgId, selectedSwap?.id],
    queryFn: () => api.skiSwap.getStats(orgId, selectedSwap!.id),
    enabled: !!selectedSwap,
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
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <StatTile label="Total Items" value={stats?.totalItems ?? '—'} />
      <StatTile label="Items Sold" value={stats?.itemsSold ?? '—'} />
      <StatTile label="Sellers" value={stats?.totalSellers ?? '—'} />
      <StatTile label="Est. Revenue" value={revenue} />
    </div>
  );
}
