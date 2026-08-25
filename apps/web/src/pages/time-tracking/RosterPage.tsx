import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { PatrollerResponse } from '../../lib/api.types';
import type { TimeTrackingContext } from './TimeTrackingLayout';
import RosterImportModal from './RosterImportModal';

const emptyDraft = { firstName: '', lastName: '', nspId: '', patrolLevel: '' };

export default function RosterPage() {
  const { orgId, perms } = useOutletContext<TimeTrackingContext>();
  const queryClient = useQueryClient();
  const canManage = perms.has('time_tracking:manage');

  const [draft, setDraft] = useState(emptyDraft);
  const [editing, setEditing] = useState<PatrollerResponse | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data: patrollers = [], isLoading } = useQuery({
    queryKey: ['time-clock/patrollers', orgId],
    queryFn: () => api.timeClock.listPatrollers(orgId),
  });

  const { data: openShifts = [] } = useQuery({
    queryKey: ['time-clock/on-shift', orgId],
    queryFn: () => api.timeClock.listShifts(orgId, { status: 'open' }),
  });
  const onShiftIds = new Set(openShifts.map((s) => s.patrollerId));

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['time-clock/patrollers', orgId] });
    queryClient.invalidateQueries({ queryKey: ['time-clock/on-shift', orgId] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      api.timeClock.createPatroller(orgId, {
        firstName: draft.firstName,
        lastName: draft.lastName,
        nspId: draft.nspId,
        patrolLevel: draft.patrolLevel || null,
      }),
    onSuccess: () => { setDraft(emptyDraft); setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });

  const updateMutation = useMutation({
    mutationFn: (p: PatrollerResponse) =>
      api.timeClock.patchPatroller(orgId, p.id, {
        firstName: p.firstName, lastName: p.lastName, nspId: p.nspId, patrolLevel: p.patrolLevel,
      }),
    onSuccess: () => { setEditing(null); setError(null); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });

  /** D14: deactivating someone on shift clocks them out, so say so before it happens. */
  const deactivateMutation = useMutation({
    mutationFn: (p: PatrollerResponse) => api.timeClock.deletePatroller(orgId, p.id),
    onSuccess: (result) => {
      setNotice(result.closedShiftId ? 'That patroller was on shift — their shift has been closed and flagged for review.' : null);
      invalidate();
    },
    onError: (e: Error) => setError(e.message),
  });

  function confirmDeactivate(p: PatrollerResponse) {
    const warning = onShiftIds.has(p.id)
      ? `${p.displayName} is currently on shift. Removing them will clock them out and flag the shift for review.\n\nContinue?`
      : `Remove ${p.displayName} from the roster?`;
    if (window.confirm(warning)) deactivateMutation.mutate(p);
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {notice && <p className="text-yellow-400 text-sm">{notice}</p>}

      {canManage && (
        <div className="bg-surface-100 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-semibold">Add a patroller</h2>
            <button onClick={() => setShowImport(true)} className="text-sm text-gray-300 hover:text-white">
              Import from CSV
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-5">
            <input className={inputClass} placeholder="First name" value={draft.firstName}
              onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
            <input className={inputClass} placeholder="Last name" value={draft.lastName}
              onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
            <input className={inputClass} placeholder="NSP ID" value={draft.nspId}
              onChange={(e) => setDraft({ ...draft, nspId: e.target.value })} />
            <input className={inputClass} placeholder="Patrol level" value={draft.patrolLevel}
              onChange={(e) => setDraft({ ...draft, patrolLevel: e.target.value })} />
            <button
              onClick={() => createMutation.mutate()}
              disabled={!draft.firstName || !draft.lastName || !draft.nspId || createMutation.isPending}
              className="bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded px-3 py-1.5 text-sm"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-gray-500 border-b border-gray-800">
            <tr>
              <th className="text-left py-2 font-medium">Name</th>
              <th className="text-left py-2 font-medium">NSP ID</th>
              <th className="text-left py-2 font-medium">Patrol level</th>
              <th className="text-left py-2 font-medium">Status</th>
              {canManage && <th />}
            </tr>
          </thead>
          <tbody>
            {patrollers.map((p) => {
              const isEditing = editing?.id === p.id;
              return (
                <tr key={p.id} className="border-b border-gray-900">
                  <td className="py-2 text-white">
                    {isEditing ? (
                      <div className="flex gap-1">
                        <input className={inputClass} value={editing.firstName}
                          onChange={(e) => setEditing({ ...editing, firstName: e.target.value })} />
                        <input className={inputClass} value={editing.lastName}
                          onChange={(e) => setEditing({ ...editing, lastName: e.target.value })} />
                      </div>
                    ) : p.displayName}
                  </td>
                  <td className="py-2 text-gray-300 tabular-nums">
                    {isEditing ? (
                      <input className={inputClass} value={editing.nspId}
                        onChange={(e) => setEditing({ ...editing, nspId: e.target.value })} />
                    ) : p.nspId}
                  </td>
                  <td className="py-2 text-gray-400">
                    {isEditing ? (
                      <input className={inputClass} value={editing.patrolLevel ?? ''}
                        onChange={(e) => setEditing({ ...editing, patrolLevel: e.target.value })} />
                    ) : (p.patrolLevel ?? '—')}
                  </td>
                  <td className="py-2">
                    {onShiftIds.has(p.id)
                      ? <span className="text-green-400 text-xs">On shift</span>
                      : <span className="text-gray-500 text-xs">Off</span>}
                  </td>
                  {canManage && (
                    <td className="py-2 text-right space-x-3">
                      {isEditing ? (
                        <>
                          <button onClick={() => updateMutation.mutate(editing)} className="text-green-400 text-xs">Save</button>
                          <button onClick={() => setEditing(null)} className="text-gray-500 text-xs">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setEditing(p)} className="text-gray-400 hover:text-white text-xs">Edit</button>
                          <button onClick={() => confirmDeactivate(p)} className="text-red-400 hover:text-red-300 text-xs">Remove</button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {showImport && (
        <RosterImportModal
          orgId={orgId}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); invalidate(); }}
        />
      )}
    </div>
  );
}

const inputClass = 'bg-surface-50 border border-gray-700 rounded px-2 py-1 text-sm text-white w-full';
