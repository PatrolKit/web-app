import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ShiftResponse } from '../../lib/api.types';
import type { TimeTrackingContext } from './TimeTrackingLayout';
import { DutyBadge, elapsedLabel, formatDateTime, fromLocalInput, toLocalInput } from './shared';

type View = 'stillOpen' | 'needsReview' | 'all';

const DUTY_TYPES = ['patrol', 'training', 'instruction', 'other'];

/** Opens on "still open" — shifts whose sweep has passed and no device closed (§6.4). */
export default function ShiftsPage() {
  const { orgId, perms } = useOutletContext<TimeTrackingContext>();
  const queryClient = useQueryClient();
  const canEdit = perms.has('time_tracking:manage');

  const [view, setView] = useState<View>('stillOpen');
  const [resortId, setResortId] = useState('');
  const [dutyType, setDutyType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [editing, setEditing] = useState<ShiftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: resorts = [] } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
  });

  const params = {
    resortId: resortId || undefined,
    dutyType: dutyType || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    ...(view === 'stillOpen' ? { status: 'open', pastSweep: true } : {}),
  };

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['time-clock/shifts', orgId, view, params],
    queryFn: () => api.timeClock.listShifts(orgId, params),
  });

  const visible = view === 'needsReview' ? shifts.filter((s) => s.flagged) : shifts;

  const patchMutation = useMutation({
    mutationFn: (shift: ShiftResponse) =>
      api.timeClock.patchShift(orgId, shift.id, {
        clockInAt: shift.clockInAt,
        clockOutAt: shift.clockOutAt,
        dutyType: shift.dutyType,
        dutyNote: shift.dutyNote,
      }),
    onSuccess: () => {
      setEditing(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['time-clock/shifts', orgId] });
      queryClient.invalidateQueries({ queryKey: ['time-clock/on-shift', orgId] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-sm">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {(['stillOpen', 'needsReview', 'all'] as View[]).map((v) => (
          <button key={v} onClick={() => setView(v)}
            className={`text-sm px-3 py-1.5 rounded ${view === v ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`}>
            {v === 'stillOpen' ? 'Still open' : v === 'needsReview' ? 'Needs review' : 'All shifts'}
          </button>
        ))}

        <span className="flex-1" />

        <select className={inputClass} value={resortId} onChange={(e) => setResortId(e.target.value)}>
          <option value="">All resorts</option>
          {resorts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select className={inputClass} value={dutyType} onChange={(e) => setDutyType(e.target.value)}>
          <option value="">All duties</option>
          {DUTY_TYPES.map((d) => <option key={d} value={d} className="capitalize">{d}</option>)}
        </select>
        <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
      </div>

      {view === 'stillOpen' && (
        <p className="text-gray-500 text-sm">
          Shifts whose automatic clock-out time has passed with no device around to close them.
        </p>
      )}

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="text-gray-500 text-sm py-8 text-center">Nothing here.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-gray-500 border-b border-gray-800">
            <tr>
              <th className="text-left py-2 font-medium">Patroller</th>
              <th className="text-left py-2 font-medium">Resort</th>
              <th className="text-left py-2 font-medium">Duty</th>
              <th className="text-left py-2 font-medium">Note</th>
              <th className="text-left py-2 font-medium">In</th>
              <th className="text-left py-2 font-medium">Out</th>
              <th className="text-left py-2 font-medium">Length</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {visible.map((shift) => {
              const isEditing = editing?.id === shift.id;
              return (
                <tr key={shift.id} className="border-b border-gray-900 align-top">
                  <td className="py-2 text-white">
                    {shift.patrollerName}
                    {shift.flagged && <span className="ml-2 text-yellow-400 text-xs">needs review</span>}
                    {shift.closeReason && shift.closeReason !== 'manual' && (
                      <span className="ml-2 text-gray-500 text-xs">{shift.closeReason}</span>
                    )}
                  </td>
                  <td className="py-2 text-gray-400">{shift.resortName}</td>
                  <td className="py-2">
                    {isEditing ? (
                      <select className={inputClass} value={editing.dutyType}
                        onChange={(e) => setEditing({ ...editing, dutyType: e.target.value })}>
                        {DUTY_TYPES.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    ) : <DutyBadge dutyType={shift.dutyType} />}
                  </td>
                  <td className="py-2 text-gray-400 max-w-[16rem]">
                    {isEditing ? (
                      <input className={inputClass} value={editing.dutyNote ?? ''}
                        onChange={(e) => setEditing({ ...editing, dutyNote: e.target.value || null })} />
                    ) : (shift.dutyNote ?? '—')}
                  </td>
                  <td className="py-2 text-gray-300">
                    {isEditing ? (
                      <input type="datetime-local" className={inputClass} value={toLocalInput(editing.clockInAt)}
                        onChange={(e) => setEditing({ ...editing, clockInAt: fromLocalInput(e.target.value) })} />
                    ) : formatDateTime(shift.clockInAt)}
                  </td>
                  <td className="py-2 text-gray-300">
                    {isEditing ? (
                      <input type="datetime-local" className={inputClass} value={toLocalInput(editing.clockOutAt)}
                        onChange={(e) => setEditing({
                          ...editing,
                          clockOutAt: e.target.value ? fromLocalInput(e.target.value) : null,
                        })} />
                    ) : shift.clockOutAt ? formatDateTime(shift.clockOutAt) : <span className="text-green-400">on shift</span>}
                  </td>
                  <td className="py-2 text-gray-400 tabular-nums">
                    {elapsedLabel(shift.clockInAt, shift.clockOutAt)}
                  </td>
                  {canEdit && (
                    <td className="py-2 text-right space-x-3 whitespace-nowrap">
                      {isEditing ? (
                        <>
                          <button onClick={() => patchMutation.mutate(editing)} className="text-green-400 text-xs">Save</button>
                          <button onClick={() => setEditing(null)} className="text-gray-500 text-xs">Cancel</button>
                        </>
                      ) : (
                        <button onClick={() => setEditing(shift)} className="text-gray-400 hover:text-white text-xs">Edit</button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const inputClass = 'bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white';
