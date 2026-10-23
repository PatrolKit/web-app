import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ShiftResponse } from '../../lib/api.types';
import type { TimeTrackingContext } from './TimeTrackingLayout';
import {
  DutyBadge, PeriodPicker, elapsedLabel, formatDateTime, fromLocalInput, periodParams, toLocalInput,
  type Period,
} from './shared';
import { ShiftHistoryDialog } from './ShiftHistoryDialog';

type View = 'stillOpen' | 'needsReview' | 'all';

const DUTY_TYPES = ['patrol', 'training', 'instruction', 'other'];
const PAGE = 100;

/** Opens on "still open" — shifts whose sweep has passed and no device closed (§6.4). */
export default function ShiftsPage() {
  const { orgId, perms } = useOutletContext<TimeTrackingContext>();
  const queryClient = useQueryClient();
  const canEdit = perms.has('time_tracking:manage');

  const [view, setView] = useState<View>('stillOpen');
  const [resortId, setResortId] = useState('');
  const [dutyType, setDutyType] = useState('');
  const [chosen, setChosen] = useState<Period | null>(null);
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<ShiftResponse | null>(null);
  const [reopening, setReopening] = useState<ShiftResponse | null>(null);
  const [historyOf, setHistoryOf] = useState<ShiftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: resorts = [] } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
  });
  const { data: seasons } = useQuery({
    queryKey: ['time-clock/seasons', orgId],
    queryFn: () => api.timeClock.seasons(orgId),
  });

  // The current season until someone picks something else (D12). "Still open" ignores the
  // period: a shift nobody closed is worth seeing whenever it started.
  const period: Period | null =
    chosen ?? (seasons ? { kind: 'season', startYear: seasons.current.startYear } : null);
  const params = {
    resortId: resortId || undefined,
    dutyType: dutyType || undefined,
    ...(view === 'stillOpen' ? { status: 'open', pastSweep: true } : periodParams(period)),
    ...(view === 'needsReview' ? { flagged: true } : {}),
    skip: page * PAGE,
    take: PAGE,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['time-clock/shifts', orgId, view, params],
    queryFn: () => api.timeClock.listShifts(orgId, params),
    enabled: view === 'stillOpen' || !!period,
  });
  const shifts = data?.shifts ?? [];
  const total = data?.total ?? 0;

  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };

  const patchMutation = useMutation({
    mutationFn: ({ shift, data }: { shift: ShiftResponse; data: Parameters<typeof api.timeClock.patchShift>[2] }) =>
      api.timeClock.patchShift(orgId, shift.id, data),
    onSuccess: () => {
      setEditing(null);
      setReopening(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['time-clock/shifts', orgId] });
      queryClient.invalidateQueries({ queryKey: ['time-clock/on-shift', orgId] });
    },
    onError: (e: Error) => setError(e.message),
  });

  function save(shift: ShiftResponse, edited: ShiftResponse) {
    // Clearing the clock-out of a closed shift reopens it, which is worth a sentence first.
    if (shift.clockOutAt && !edited.clockOutAt) {
      setReopening(edited);
      return;
    }
    patchMutation.mutate({
      shift,
      data: {
        clockInAt: edited.clockInAt,
        clockOutAt: edited.clockOutAt,
        dutyType: edited.dutyType,
        dutyNote: edited.dutyNote,
      },
    });
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-sm" role="alert">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        {(['stillOpen', 'needsReview', 'all'] as View[]).map((v) => (
          <button key={v} onClick={() => reset(setView)(v)}
            className={`text-sm px-3 py-1.5 rounded ${view === v ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`}>
            {v === 'stillOpen' ? 'Still open' : v === 'needsReview' ? 'Needs review' : 'All shifts'}
          </button>
        ))}

        <span className="flex-1" />

        <select className={inputClass} value={resortId} onChange={(e) => reset(setResortId)(e.target.value)}>
          <option value="">All resorts</option>
          {resorts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <select className={inputClass} value={dutyType} onChange={(e) => reset(setDutyType)(e.target.value)}>
          <option value="">All duties</option>
          {DUTY_TYPES.map((d) => <option key={d} value={d} className="capitalize">{d}</option>)}
        </select>
        {view !== 'stillOpen' && seasons && (
          <PeriodPicker seasons={seasons.seasons} period={period} onChange={reset(setChosen)} className={inputClass} />
        )}
      </div>

      {view === 'stillOpen' && (
        <p className="text-gray-500 text-sm">
          Shifts whose automatic clock-out time has passed with no device around to close them.
        </p>
      )}

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : shifts.length === 0 ? (
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
            {shifts.map((shift) => {
              const isEditing = editing?.id === shift.id;
              return (
                <tr key={shift.id} className="border-b border-gray-900 align-top">
                  <td className="py-2 text-white">
                    {shift.patrollerName}
                    {shift.flagged && <span className="ml-2 text-yellow-400 text-xs">needs review</span>}
                    {shift.closeReason && shift.closeReason !== 'manual' && (
                      <span className="ml-2 text-gray-500 text-xs">{shift.closeReason}</span>
                    )}
                    {shift.edited && (
                      <button onClick={() => setHistoryOf(shift)}
                        className="ml-2 text-xs text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline">
                        Edited
                      </button>
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
                          <button onClick={() => save(shift, editing)} className="text-green-400 text-xs">Save</button>
                          <button onClick={() => setEditing(null)} className="text-gray-500 text-xs">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => setHistoryOf(shift)} className="text-gray-500 hover:text-white text-xs">History</button>
                          <button onClick={() => setEditing(shift)} className="text-gray-400 hover:text-white text-xs">Edit</button>
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

      {total > PAGE && (
        <div className="flex items-center justify-end gap-3 text-sm text-gray-400">
          <span>{page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}</span>
          <button disabled={page === 0} onClick={() => setPage(page - 1)} className="hover:text-white disabled:opacity-40">Previous</button>
          <button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)} className="hover:text-white disabled:opacity-40">Next</button>
        </div>
      )}

      {reopening && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-white font-semibold">Reopen this shift?</h3>
            <p className="text-gray-300 text-sm">
              {reopening.patrollerName} will show as on shift again. The clock-out is set aside, not
              deleted, and stays in the shift's history.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setReopening(null)} className="text-gray-400 hover:text-white text-sm px-3 py-1.5">Cancel</button>
              <button
                onClick={() => {
                  const original = shifts.find((s) => s.id === reopening.id) ?? reopening;
                  patchMutation.mutate({
                    shift: original,
                    data: {
                      clockInAt: reopening.clockInAt,
                      clockOutAt: null,
                      dutyType: reopening.dutyType,
                      dutyNote: reopening.dutyNote,
                    },
                  });
                }}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-1.5 rounded text-sm"
              >
                Reopen
              </button>
            </div>
          </div>
        </div>
      )}

      {historyOf && <ShiftHistoryDialog orgId={orgId} shift={historyOf} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

const inputClass = 'bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white';
