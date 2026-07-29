import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { SwapResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

function mutationError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

interface SwapForm { title: string; locationId: string; }
const emptyForm: SwapForm = { title: '', locationId: '' };

export default function SwapsPage() {
  const { orgId, perms, swaps, setSelectedSwapId } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editSwap, setEditSwap] = useState<SwapResponse | null>(null);
  const [form, setForm] = useState<SwapForm>(emptyForm);

  const { data: locationsData, isLoading: locationsLoading, error: locationsError } = useQuery({
    queryKey: ['ski-swap/locations', orgId],
    queryFn: () => api.skiSwap.listLocations(orgId),
    enabled: !!orgId && showForm,
    staleTime: 60_000,
  });

  const locations = locationsData?.locations ?? [];

  // Auto-select when only one location
  if (locations.length === 1 && !form.locationId) {
    setForm((f) => ({ ...f, locationId: locations[0].id }));
  }

  const createMutation = useMutation({
    mutationFn: () => api.skiSwap.createSwap(orgId, form.title, form.locationId),
    onSuccess: (swap) => {
      qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] });
      setSelectedSwapId(swap.id);
      setShowForm(false);
      setForm(emptyForm);
    },
  });

  const patchMutation = useMutation({
    mutationFn: (s: SwapResponse) => api.skiSwap.patchSwap(orgId, s.id, {
      title: form.title !== s.title ? form.title : undefined,
      locationId: form.locationId !== s.locationId ? form.locationId : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] });
      setEditSwap(null);
      setForm(emptyForm);
      setShowForm(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.skiSwap.patchSwap(orgId, id, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] }),
  });

  function openCreate() {
    setEditSwap(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(s: SwapResponse) {
    setEditSwap(s);
    setForm({ title: s.title, locationId: s.locationId });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditSwap(null);
    setForm(emptyForm);
  }

  const isSubmitting = createMutation.isPending || patchMutation.isPending;
  const mutError = createMutation.error ?? patchMutation.error ?? toggleMutation.error;

  return (
    <div className="space-y-4">
      {perms.has('ski_swap:admin') && !showForm && (
        <button onClick={openCreate}
          className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
          + New Swap
        </button>
      )}

      {mutError && <p className="text-red-400 text-sm">{mutationError(mutError)}</p>}

      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); editSwap ? patchMutation.mutate(editSwap) : createMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-4"
        >
          <h3 className="text-white font-medium">{editSwap ? 'Edit Swap' : 'New Swap'}</h3>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Title</span>
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder='e.g. "Ski Swap 2026"'
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
          </label>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Location</span>
            {locationsLoading ? (
              <p className="mt-1 text-gray-500 text-sm">Loading locations…</p>
            ) : locationsError ? (
              <p className="mt-1 text-red-400 text-sm">
                {locationsError instanceof ApiError ? locationsError.message : 'Could not load locations'}
              </p>
            ) : locations.length === 0 ? (
              <p className="mt-1 text-red-400 text-sm">No active locations found. Check your Square credentials.</p>
            ) : (
              <>
                <select required value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}
                  className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white">
                  {locations.length > 1 && <option value="">Select a location…</option>}
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                {locations.length === 1 && (
                  <p className="mt-1 text-gray-500 text-xs">One location found — selected automatically.</p>
                )}
              </>
            )}
          </label>

          <div className="flex gap-2">
            <button type="submit" disabled={isSubmitting || !form.locationId || !form.title}
              className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium">
              {editSwap ? 'Save' : 'Create'}
            </button>
            <button type="button" onClick={closeForm}
              className="text-gray-400 hover:text-white text-sm px-3 py-2">Cancel</button>
          </div>
        </form>
      )}

      {swaps.length === 0 ? (
        <p className="text-gray-400 text-sm">No swaps yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left border-b border-gray-800">
              <th className="pb-2 pr-4">Title</th>
              <th className="pb-2 pr-4">SKU Prefix</th>
              <th className="pb-2 pr-4">Status</th>
              {perms.has('ski_swap:admin') && <th className="pb-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {swaps.map((s) => (
              <tr key={s.id} className="border-b border-gray-900">
                <td className="py-2 pr-4 text-white">{s.title}</td>
                <td className="py-2 pr-4 text-gray-400 font-mono">{s.skuPrefix}</td>
                <td className="py-2 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded ${s.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'}`}>
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                {perms.has('ski_swap:admin') && (
                  <td className="py-2 flex gap-3">
                    <button onClick={() => openEdit(s)}
                      className="text-xs text-brand-500 hover:underline">Edit</button>
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
