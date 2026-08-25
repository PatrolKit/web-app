import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TimeTrackingContext } from './TimeTrackingLayout';
import { DutyBadge, elapsedLabel, formatTime } from './shared';

/** Mirrors the iPad board, grouped by resort. */
export default function OnShiftPage() {
  const { orgId } = useOutletContext<TimeTrackingContext>();

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['time-clock/on-shift', orgId],
    queryFn: () => api.timeClock.listShifts(orgId, { status: 'open' }),
    refetchInterval: 30_000,
  });

  const byResort = shifts.reduce<Record<string, typeof shifts>>((acc, shift) => {
    const key = shift.resortName ?? 'Unknown resort';
    (acc[key] ||= []).push(shift);
    return acc;
  }, {});

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;

  if (shifts.length === 0) {
    return (
      <div className="py-16 text-center space-y-2">
        <p className="text-xl font-semibold text-gray-300">No one is on shift</p>
        <p className="text-gray-500 text-sm">Clock-ins from any iPad appear here within a minute.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {Object.entries(byResort).map(([resort, rows]) => (
        <section key={resort} className="space-y-3">
          <h2 className="text-lg font-semibold text-white">
            {resort} <span className="text-gray-500 text-sm font-normal">· {rows.length} on shift</span>
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {rows
              .slice()
              .sort((a, b) => (a.patrollerName ?? '').localeCompare(b.patrollerName ?? ''))
              .map((shift) => (
                <div key={shift.id} className="bg-surface-100 rounded-lg p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-white font-semibold">{shift.patrollerName}</p>
                      {shift.patrolLevel && <p className="text-gray-500 text-xs">{shift.patrolLevel}</p>}
                    </div>
                    <DutyBadge dutyType={shift.dutyType} />
                  </div>
                  {shift.dutyNote && <p className="text-gray-400 text-xs truncate">{shift.dutyNote}</p>}
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">in at {formatTime(shift.clockInAt)}</span>
                    <span className="text-gray-300 tabular-nums">{elapsedLabel(shift.clockInAt)}</span>
                  </div>
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
