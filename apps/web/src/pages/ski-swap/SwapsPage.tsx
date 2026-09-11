import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { SwapResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

function mutationError(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong';
}

interface SwapForm {
  title: string;
  locationId: string;
  legacyTicketsEnabled: boolean;
  legacyTicketsOnly: boolean;
}
const emptyForm: SwapForm = {
  title: '', locationId: '', legacyTicketsEnabled: false, legacyTicketsOnly: false,
};

export default function SwapsPage() {
  const { orgId, perms, setSelectedSwapId } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editSwap, setEditSwap] = useState<SwapResponse | null>(null);
  const [form, setForm] = useState<SwapForm>(emptyForm);
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [titleSort, setTitleSort] = useState<'creation' | 'asc' | 'desc'>('creation');

  // Fetch ALL swaps (including inactive) for the management view
  const { data: allSwaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps-all', orgId],
    queryFn: () => api.skiSwap.listSwaps(orgId),
    enabled: !!orgId,
  });
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
      qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] }); qc.invalidateQueries({ queryKey: ['ski-swap/swaps-all', orgId] });
      setSelectedSwapId(swap.id);
      setShowForm(false);
      setForm(emptyForm);
    },
  });

  const patchMutation = useMutation({
    mutationFn: (s: SwapResponse) => api.skiSwap.patchSwap(orgId, s.id, {
      title: form.title !== s.title ? form.title : undefined,
      locationId: form.locationId !== s.locationId ? form.locationId : undefined,
      legacyTicketsEnabled:
        form.legacyTicketsEnabled !== s.legacyTicketsEnabled ? form.legacyTicketsEnabled : undefined,
      legacyTicketsOnly:
        form.legacyTicketsOnly !== s.legacyTicketsOnly ? form.legacyTicketsOnly : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] }); qc.invalidateQueries({ queryKey: ['ski-swap/swaps-all', orgId] });
      setEditSwap(null);
      setForm(emptyForm);
      setShowForm(false);
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.skiSwap.patchSwap(orgId, id, { active }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/swaps', orgId] }); qc.invalidateQueries({ queryKey: ['ski-swap/swaps-all', orgId] }); },
  });

  function openCreate() {
    setEditSwap(null);
    setForm(emptyForm);
    setShowForm(true);
  }

  function openEdit(s: SwapResponse) {
    setEditSwap(s);
    setForm({
      title: s.title,
      locationId: s.locationId,
      legacyTicketsEnabled: s.legacyTicketsEnabled,
      legacyTicketsOnly: s.legacyTicketsOnly,
    });
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
        {perms.has('ski_swap:admin') && !showForm && (
          <button onClick={openCreate}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
            + New Swap
          </button>
        )}
      </div>

      {mutError && <p className="text-red-400 text-sm">{mutationError(mutError)}</p>}

      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (editSwap) patchMutation.mutate(editSwap); else createMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-4"
        >
          <h3 className="text-white font-medium">{editSwap ? 'Edit Swap' : 'New Swap'}</h3>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Title</span>
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder='e.g. "Ski Swap 2026"'
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white" />
          </label>

          {/* These come from Square, not from PatrolKit — the list is whatever
              the connected Square account has. Saying so avoids it reading as a
              venue or an address, which is what "Location" suggests on its own. */}
          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Square Location</span>
            {locationsLoading ? (
              <p className="mt-1 text-gray-500 text-sm">Loading locations from Square…</p>
            ) : locationsError ? (
              <p className="mt-1 text-red-400 text-sm">
                {locationsError instanceof ApiError ? locationsError.message : 'Could not load locations from Square'}
              </p>
            ) : locations.length === 0 ? (
              <p className="mt-1 text-red-400 text-sm">
                No active locations found in Square. Check your Square credentials under Administration.
              </p>
            ) : (
              <>
                <select required value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}
                  className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white">
                  {locations.length > 1 && <option value="">Select a Square location…</option>}
                  {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <p className="mt-1 text-gray-500 text-xs">
                  {locations.length === 1 ? 'One Square location found — selected automatically. ' : ''}
                  Items in this swap are listed and their inventory tracked against this
                  location in your Square account. It is not the venue address.
                </p>
              </>
            )}
          </label>

          {/* Edit only. A new swap starts off — that is what "default off"
              means — and turning it on is a decision about a swap that exists,
              usually taken when the first box of old tickets turns up. */}
          {editSwap && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={form.legacyTicketsEnabled}
                // Clearing the parent clears the child, the same rule the
                // server keeps: "only tickets" cannot outlive taking them.
                onChange={(e) => setForm({
                  ...form,
                  legacyTicketsEnabled: e.target.checked,
                  legacyTicketsOnly: e.target.checked ? form.legacyTicketsOnly : false,
                })}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm text-white">Accept legacy tickets</span>
                <span className="block text-gray-500 text-xs mt-0.5">
                  For gear that arrives already carrying a numbered ticket from the old
                  stockpile, instead of a tag printed at check-in. Turns on issuing ticket
                  blocks to business sellers, and the staff iPad's option to scan a loose
                  one during an individual's check-in.
                </span>
              </span>
            </label>
          )}

          {/* Nested, because it only means anything once tickets are taken at
              all. It appears rather than greying out: the question "tickets
              only?" does not exist for a swap on printed tags. */}
          {editSwap && form.legacyTicketsEnabled && (
            <label className="flex items-start gap-3 pl-7">
              <input
                type="checkbox"
                checked={form.legacyTicketsOnly}
                onChange={(e) => setForm({ ...form, legacyTicketsOnly: e.target.checked })}
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm text-white">Legacy tickets only</span>
                <span className="block text-gray-500 text-xs mt-0.5">
                  Every item comes in on a numbered ticket and nothing prints a tag. The
                  staff iPad reads this to decide what it offers.
                </span>
              </span>
            </label>
          )}

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
                <td className="py-2 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded ${s.active ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'}`}>
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                  {s.legacyTicketsEnabled && (
                    <span
                      className="ml-2 text-xs px-2 py-0.5 rounded bg-surface-100 text-gray-400"
                      title="Accepts gear that arrives on a numbered ticket from the old stockpile"
                    >
                      Legacy tickets
                    </span>
                  )}
                  {/* Coloured rather than a second grey pill: the two settings
                      differ by one trailing word, and a column of near-identical
                      badges is read by its colour, not by its text. */}
                  {s.legacyTicketsOnly && (
                    <span
                      className="ml-2 text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300"
                      title="Every item comes in on a numbered ticket — nothing prints a tag"
                    >
                      Tickets only
                    </span>
                  )}
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
