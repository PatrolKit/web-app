import { useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { SwapResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import { useAuth } from '../../contexts/AuthContext';
import SwapSettingsModal from './SwapSettingsModal';

/** "check-in", "web", or both, for a badge. */
function places(checkin: boolean, web: boolean): string {
  return [checkin && 'check-in', web && 'web'].filter(Boolean).join(', ') || 'none';
}

function mutationError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

export default function SwapsPage() {
  const { orgId, perms, setSelectedSwapId } = useOutletContext<SkiSwapContext>();
  const { user } = useAuth();
  const orgSlug = user?.memberships.find((m) => m.orgId === orgId)?.orgSlug ?? '';
  const qc = useQueryClient();
  /** The swap being edited in the dialog; `'new'` while creating one. */
  const [editing, setEditing] = useState<SwapResponse | 'new' | null>(null);
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [titleSort, setTitleSort] = useState<'creation' | 'asc' | 'desc'>('creation');

  // Fetch ALL swaps (including inactive) for the management view
  const { data: allSwaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps-all', orgId],
    queryFn: () => api.skiSwap.listSwaps(orgId),
    enabled: !!orgId,
  });

  function saved(swap: SwapResponse) {
    qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] });
    qc.invalidateQueries({ queryKey: ['ski-swap/swaps-all', orgId] });
    if (editing === 'new') setSelectedSwapId(swap.id);
    setEditing(null);
  }

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.skiSwap.patchSwap(orgId, id, { active }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] }); qc.invalidateQueries({ queryKey: ['ski-swap/swaps-all', orgId] }); },
  });

  const mutError = toggleMutation.error;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            <option value="all">All swaps</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>

        </div>
        {perms.has('ski_swap:admin') && (
          <button onClick={() => setEditing('new')}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
            + New Swap
          </button>
        )}
      </div>

      {mutError && <p className="text-red-400 text-sm">{mutationError(mutError)}</p>}

      {editing && (
        <SwapSettingsModal
          orgId={orgId}
          orgSlug={orgSlug}
          swap={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}

      {allSwaps.length === 0 ? (
        <p className="text-gray-400 text-sm">No swaps yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left border-b border-gray-800">
              <th
                className="pb-2 pr-4 cursor-pointer select-none whitespace-nowrap"
                onClick={() => {
                  const cycle: typeof titleSort[] = ['creation', 'asc', 'desc'];
                  setTitleSort(cycle[(cycle.indexOf(titleSort) + 1) % cycle.length]);
                }}
              >
                <span className={titleSort !== 'creation' ? 'text-white' : ''}>Title</span>
                <span className="ml-1 text-gray-600">
                  {titleSort === 'asc' ? '↑' : titleSort === 'desc' ? '↓' : '↕'}
                </span>
              </th>
              <th className="pb-2 pr-4">SKU Prefix</th>
              <th className="pb-2 pr-4">Slug</th>
              <th className="pb-2 pr-4">Status</th>
              {perms.has('ski_swap:admin') && <th className="pb-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {[...allSwaps]
              .filter((s) => statusFilter === 'all' || (statusFilter === 'active' ? s.active : !s.active))
              .sort((a, b) => {
                if (titleSort === 'asc') return a.title.localeCompare(b.title);
                if (titleSort === 'desc') return b.title.localeCompare(a.title);
                return 0; // 'creation' — preserve server order (createdAt desc)
              })
              .map((s) => (
              <tr key={s.id} className="border-b border-gray-900">
                <td className="py-2 pr-4 text-white">{s.title}</td>
                <td className="py-2 pr-4 text-gray-400 font-mono">{s.skuPrefix}</td>
                <td className="py-2 pr-4 text-gray-400 font-mono">{s.slug}</td>
                <td className="py-2 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded ${s.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'}`}>
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                  {/* How items come in, said positively (Plan 34). Shown only
                      where it differs from a new swap's: print tickets in both
                      places, no legacy tickets. */}
                  {(s.allowLegacyCheckin || s.allowLegacyWeb) && (
                    <span
                      className="ml-2 text-xs px-2 py-0.5 rounded bg-surface-100 text-gray-400"
                      title="Takes gear that arrives on a numbered ticket from the old stockpile"
                    >
                      Legacy: {places(s.allowLegacyCheckin, s.allowLegacyWeb)}
                    </span>
                  )}
                  {/* Amber: a place without print tickets is the one that
                      surprises somebody at a counter. */}
                  {!(s.allowPrintCheckin && s.allowPrintWeb) && (
                    <span
                      className="ml-2 text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300"
                      title="Where an item can get a printed tag"
                    >
                      Print: {places(s.allowPrintCheckin, s.allowPrintWeb)}
                    </span>
                  )}
                </td>
                {perms.has('ski_swap:admin') && (
                  <td className="py-2 flex gap-3">
                    <button onClick={() => setEditing(s)}
                      className="text-xs text-brand-500 hover:underline">Edit</button>
                    {/* Diagnostics live in Reports › Catalog check now (Plan 48 D2), for this swap. */}
                    <button onClick={() => { setSelectedSwapId(s.id); navigate('/dashboard/ski-swap/reports/catalog'); }}
                      className="text-xs text-brand-500 hover:underline">Diagnostics</button>
                    <button onClick={() => toggleMutation.mutate({ id: s.id, active: !s.active })}
                      disabled={toggleMutation.isPending}
                      className="text-xs text-brand-500 hover:underline">
                      {s.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
