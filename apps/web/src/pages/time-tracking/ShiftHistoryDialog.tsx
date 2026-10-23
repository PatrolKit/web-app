import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ShiftResponse } from '../../lib/api.types';
import { formatDateTime } from './shared';

const ACTIONS: Record<string, string> = {
  'time_clock.shift.corrected': 'Corrected',
  'time_clock.shift.reopened': 'Reopened',
  'time_clock.shift.closed_by_roster': 'Closed when removed from the roster',
};

const SOURCES: Record<string, string> = {
  device: 'on the iPad',
  device_auto: 'automatically',
  admin: 'by staff',
};

const FIELDS: Record<string, string> = {
  clockInAt: 'In',
  clockOutAt: 'Out',
  dutyType: 'Duty',
  dutyNote: 'Note',
};

function show(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'clockInAt' || field === 'clockOutAt') return formatDateTime(String(value));
  return String(value);
}

/** What happened to one shift, from its events and its audit rows (Plan 55 D11). */
export function ShiftHistoryDialog({ orgId, shift, onClose }: { orgId: string; shift: ShiftResponse; onClose: () => void }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['time-clock/shift-history', orgId, shift.id],
    queryFn: () => api.timeClock.shiftHistory(orgId, shift.id),
  });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        role="dialog"
        aria-labelledby="shift-history-title"
        className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-lg w-full mx-4 space-y-5 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h3 id="shift-history-title" className="text-white font-semibold">
            {shift.patrollerName}, {formatDateTime(shift.clockInAt)}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-sm">Close</button>
        </div>

        {isLoading && <p className="text-gray-400 text-sm">Loading…</p>}
        {error && <p className="text-red-400 text-sm">{(error as Error).message}</p>}

        {data && (
          <>
            <section className="space-y-2">
              <h4 className="text-gray-400 text-xs uppercase tracking-wide">Changes</h4>
              {data.changes.length === 0 ? (
                <p className="text-gray-500 text-sm">Never corrected.</p>
              ) : (
                <ul className="space-y-3">
                  {data.changes.map((c, i) => (
                    <li key={i} className="text-sm">
                      <p className="text-white">
                        {ACTIONS[c.action] ?? c.action}
                        <span className="text-gray-500"> · {c.actorName ?? 'someone'} · {formatDateTime(c.at)}</span>
                      </p>
                      {c.before && c.after && (
                        <ul className="text-gray-400 text-xs mt-1 space-y-0.5">
                          {Object.keys(FIELDS)
                            .filter((f) => JSON.stringify(c.before?.[f]) !== JSON.stringify(c.after?.[f]))
                            .map((f) => (
                              <li key={f}>
                                {FIELDS[f]}: {show(f, c.before?.[f])} → <span className="text-gray-200">{show(f, c.after?.[f])}</span>
                              </li>
                            ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-2">
              <h4 className="text-gray-400 text-xs uppercase tracking-wide">Clock events</h4>
              <ul className="space-y-1.5 text-sm">
                {data.events.map((e) => (
                  <li key={e.id} className={e.status === 'voided' ? 'text-gray-500 line-through' : 'text-gray-300'}>
                    {e.type === 'clock_in' ? 'Clocked in' : 'Clocked out'} {SOURCES[e.source] ?? e.source},{' '}
                    {formatDateTime(e.occurredAt)}
                    {e.deviceName && <span className="text-gray-500"> · {e.deviceName}</span>}
                    {e.status !== 'applied' && <span className="text-gray-500 no-underline"> ({e.status === 'voided' ? 'set aside' : e.status})</span>}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
