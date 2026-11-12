import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
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
  const { orgId } = useOutletContext<TimeTrackingContext>();
  const [params, setParams] = useSearchParams();

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
      <div role="tablist" aria-label="Resorts" className="flex flex-wrap gap-2">
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
            {entries.length === 0 && (
              <p className="text-gray-500 text-sm">
                Every member can clock in. People are added and edited under{' '}
                <Link to="/dashboard/members" className="text-brand-500 hover:underline">Members</Link>.
              </p>
            )}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
