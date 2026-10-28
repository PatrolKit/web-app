import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TimeTrackingContext } from './TimeTrackingLayout';
import { DutyBadge, elapsedLabel, formatTime } from './shared';

/** Mirrors the iPad board, grouped by resort. */
export default function ClockedInPage() {
  const { orgId } = useOutletContext<TimeTrackingContext>();

  const { data, isLoading } = useQuery({
    queryKey: ['time-clock/clocked-in', orgId],
    queryFn: () => api.timeClock.listEntries(orgId, { status: 'open', take: 500 }),
    refetchInterval: 30_000,
  });
  const entries = data?.entries ?? [];

  const byResort = entries.reduce<Record<string, typeof entries>>((acc, entry) => {
    const key = entry.resortName ?? 'Unknown resort';
    (acc[key] ||= []).push(entry);
    return acc;
  }, {});

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;

  if (entries.length === 0) {
    return (
      <div className="py-16 text-center space-y-2">
        <p className="text-xl font-semibold text-gray-300">No one is clocked in</p>
        <p className="text-gray-500 text-sm">Clock-ins from any iPad appear here within a minute.</p>
        <p className="text-gray-500 text-sm">
          Every member can clock in. People are added and edited under{' '}
          <Link to="/dashboard/members" className="text-brand-500 hover:underline">Members</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {Object.entries(byResort).map(([resort, rows]) => (
        <section key={resort} className="space-y-3">
          <h2 className="text-lg font-semibold text-white">
            {resort} <span className="text-gray-500 text-sm font-normal">· {rows.length} clocked in</span>
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows
              .slice()
              .sort((a, b) => (a.patrollerName ?? '').localeCompare(b.patrollerName ?? ''))
              .map((entry) => (
                <div key={entry.id} className="bg-surface-100 rounded-lg p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-white font-semibold">{entry.patrollerName}</p>
                      {entry.patrolLevel && <p className="text-gray-500 text-xs">{entry.patrolLevel}</p>}
                    </div>
                    <DutyBadge dutyType={entry.dutyType} />
                  </div>
                  {entry.dutyNote && <p className="text-gray-400 text-xs truncate">{entry.dutyNote}</p>}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">in at {formatTime(entry.clockInAt)}</span>
                    <span className="text-gray-300 tabular-nums">{elapsedLabel(entry.clockInAt)}</span>
                  </div>
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
