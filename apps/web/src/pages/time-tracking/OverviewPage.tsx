import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TimeEntryResponse } from '../../lib/api.types';
import type { TimeTrackingContext } from './TimeTrackingLayout';
import { DutyBadge, elapsedLabel, formatTime } from './shared';

type ResortTab = { id: string; name: string; entries: TimeEntryResponse[] };

/**
 * Who is clocked in, one resort at a time. Each resort's tab is green while
 * anyone is clocked in there, so a glance across the top answers "where is
 * everyone" before a resort is opened.
 */
export default function OverviewPage() {
  const { orgId, perms } = useOutletContext<TimeTrackingContext>();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const canEdit = perms.has('time_tracking:manage');
  const [clockingOut, setClockingOut] = useState<TimeEntryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The layout has already loaded these; this reads its cache.
  const { data: resorts } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
    staleTime: 60_000,
  });
  const { data, isLoading } = useQuery({
    queryKey: ['time-clock/clocked-in', orgId],
    queryFn: () => api.timeClock.listEntries(orgId, { status: 'open', take: 500 }),
    refetchInterval: 30_000,
  });

  // The same correction Time Entries makes, with the clock-out at the moment of confirming.
  const clockOut = useMutation({
    mutationFn: (entry: TimeEntryResponse) =>
      api.timeClock.patchEntry(orgId, entry.id, { clockOutAt: new Date().toISOString() }),
    onSuccess: () => {
      setClockingOut(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['time-clock/clocked-in', orgId] });
      queryClient.invalidateQueries({ queryKey: ['time-clock/entries', orgId] });
    },
    onError: (e: Error) => {
      setClockingOut(null);
      setError(e.message);
    },
  });

  if (isLoading || !resorts) return <p className="text-gray-400 text-sm">Loading…</p>;

  const entries = data?.entries ?? [];
  const tabs: ResortTab[] = resorts.map((r) => ({ id: r.id, name: r.name, entries: [] }));
  const byId = new Map(tabs.map((t) => [t.id, t]));
  for (const entry of entries) {
    let tab = byId.get(entry.resortId);
    // An entry at a resort that is no longer listed still gets a tab, so nobody
    // clocked in goes unseen.
    if (!tab) {
      tab = { id: entry.resortId, name: entry.resortName ?? 'Unknown resort', entries: [] };
      tabs.push(tab);
      byId.set(tab.id, tab);
    }
    tab.entries.push(entry);
  }

  const asked = params.get('resort');
  const selected = (asked && byId.get(asked)) || tabs.find((t) => t.entries.length > 0) || tabs[0];
  const rows = (selected?.entries ?? [])
    .slice()
    .sort((a, b) => (a.patrollerName ?? '').localeCompare(b.patrollerName ?? ''));

  return (
    <div className="space-y-6">
      {error && <p className="text-red-400 text-sm" role="alert">{error}</p>}

      <div role="tablist" aria-label="Resorts" className="flex flex-wrap justify-center gap-2">
        {tabs.map((tab) => {
          const active = tab.id === selected?.id;
          const busy = tab.entries.length > 0;
          const tone = busy
            ? active
              ? 'bg-green-600/25 border-green-500 text-green-200'
              : 'bg-green-600/10 border-green-700 text-green-300 hover:bg-green-600/20'
            : active
              ? 'bg-surface-100 border-gray-500 text-white'
              : 'bg-surface-50 border-gray-800 text-gray-400 hover:text-white';
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setParams({ resort: tab.id }, { replace: true })}
              className={`text-left min-w-[9rem] px-4 py-2 rounded-lg border transition ${tone}`}
            >
              <span className="block text-sm font-semibold">{tab.name}</span>
              <span className={`block text-xs ${busy ? '' : 'text-gray-500'}`}>
                {busy ? `${tab.entries.length} clocked in` : 'No one clocked in'}
              </span>
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {rows.length === 0 ? (
          <div className="py-12 text-center space-y-2">
            <p className="text-lg font-semibold text-gray-300">No one is clocked in at {selected?.name}</p>
            <p className="text-gray-500 text-sm">Clock-ins from any iPad appear here within a minute.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-gray-500 border-b border-gray-800">
                <tr>
                  <th className="text-left py-2 font-medium">Patroller</th>
                  <th className="text-left py-2 font-medium">Duty</th>
                  <th className="text-left py-2 font-medium">Note</th>
                  <th className="text-left py-2 font-medium">In</th>
                  <th className="text-right py-2 font-medium">Time on</th>
                  {canEdit && <th className="py-2"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((entry) => (
                  <tr key={entry.id} className="border-b border-gray-900">
                    <td className="py-2">
                      <span className="text-white">{entry.patrollerName}</span>
                      {entry.patrolLevel && <span className="text-gray-500 text-xs ml-2">{entry.patrolLevel}</span>}
                    </td>
                    <td className="py-2"><DutyBadge dutyType={entry.dutyType} /></td>
                    <td className="py-2 text-gray-400 max-w-xs truncate">{entry.dutyNote}</td>
                    <td className="py-2 text-gray-400">{formatTime(entry.clockInAt)}</td>
                    <td className="py-2 text-right text-gray-300 tabular-nums">{elapsedLabel(entry.clockInAt)}</td>
                    {canEdit && (
                      <td className="py-2 pl-4 text-right">
                        <button
                          type="button"
                          onClick={() => setClockingOut(entry)}
                          className="text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded px-2 py-1"
                        >
                          Clock out
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {clockingOut && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div role="dialog" aria-modal="true" className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-white font-semibold">Clock out {clockingOut.patrollerName}?</h3>
            <p className="text-gray-300 text-sm">
              Their time entry at {clockingOut.resortName ?? selected?.name} closes now, after{' '}
              {elapsedLabel(clockingOut.clockInAt)}. You can change the time later on Time Entries.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setClockingOut(null)}
                disabled={clockOut.isPending}
                className="text-gray-400 hover:text-white text-sm px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={() => clockOut.mutate(clockingOut)}
                disabled={clockOut.isPending}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-4 py-1.5 rounded text-sm"
              >
                {clockOut.isPending ? 'Clocking out…' : 'Clock out'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
