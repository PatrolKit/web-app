import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/timeAgo';
import type { TimeTrackingContext } from './TimeTrackingLayout';
import { formatDateTime } from './shared';

/** A terminal not heard from in this long while the season runs is worth a look. */
const QUIET_MS = 24 * 3600_000;

const REASONS: Record<string, string> = {
  clock_implausible: "The iPad's clock was wrong: dated days ahead",
  source_not_allowed: 'Claimed to be a staff correction',
  unknown_resort: 'For a resort this org does not have',
  unknown_patroller: 'For someone not on the roster',
  id_conflict: 'An event id already used elsewhere',
};

const STATUSES: Record<string, string> = {
  rejected: 'Refused',
  orphan: 'Clock-out with no clock-in',
  anomalous: 'Clock-out before its clock-in',
  voided: 'Set aside when a shift was reopened',
};

/** What went wrong, and which terminals have gone quiet (Plan 55 D13). */
export default function HealthPage() {
  const { orgId } = useOutletContext<TimeTrackingContext>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['time-clock/health', orgId],
    queryFn: () => api.timeClock.health(orgId),
    refetchInterval: 60_000,
  });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;
  if (error) return <p className="text-red-400 text-sm">{(error as Error).message}</p>;
  if (!data) return null;

  const now = Date.now();

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="text-white font-semibold">Shifts nobody closed</h2>
        {data.stillOpenPastSweep === 0 ? (
          <p className="text-gray-500 text-sm">None. Every shift past its automatic clock-out time was closed.</p>
        ) : (
          <p className="text-sm text-yellow-300">
            {data.stillOpenPastSweep} shift{data.stillOpenPastSweep === 1 ? ' is' : 's are'} still open past the
            automatic clock-out time.{' '}
            <Link to="../shifts" className="underline hover:text-yellow-200">Review them on Shifts</Link>
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-white font-semibold">Terminals</h2>
        {data.terminals.length === 0 ? (
          <p className="text-gray-500 text-sm">No time clock iPads are set up. Add one under Devices.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left py-2 font-medium">iPad</th>
                <th className="text-left py-2 font-medium">Resort</th>
                <th className="text-left py-2 font-medium">Last heard from</th>
                <th className="text-left py-2 font-medium">App</th>
              </tr>
            </thead>
            <tbody>
              {data.terminals.map((t) => {
                const quiet = !t.lastSeenAt || now - new Date(t.lastSeenAt).getTime() > QUIET_MS;
                return (
                  <tr key={t.id} className="border-b border-gray-900">
                    <td className="py-2 text-white">{t.name}</td>
                    <td className="py-2 text-gray-400">{t.resortName ?? <span className="text-yellow-400">Not placed</span>}</td>
                    <td className={`py-2 ${quiet ? 'text-yellow-400' : 'text-gray-300'}`}>
                      {t.lastSeenAt ? timeAgo(t.lastSeenAt) : 'Never'}
                    </td>
                    <td className="py-2 text-gray-400 tabular-nums">{t.appVersion ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-white font-semibold">Clock events not counted</h2>
        <p className="text-gray-500 text-sm">The last 30 days. None of these is in anyone's hours.</p>
        {data.unapplied.length === 0 ? (
          <p className="text-gray-500 text-sm">None.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left py-2 font-medium">Patroller</th>
                <th className="text-left py-2 font-medium">Event</th>
                <th className="text-left py-2 font-medium">Why</th>
                <th className="text-left py-2 font-medium">iPad</th>
              </tr>
            </thead>
            <tbody>
              {data.unapplied.map((e) => (
                <tr key={e.id} className="border-b border-gray-900 align-top">
                  <td className="py-2 text-white">{e.patrollerName ?? '—'}</td>
                  <td className="py-2 text-gray-300">
                    {e.type === 'clock_in' ? 'In' : 'Out'}, {formatDateTime(e.occurredAt)}
                    {e.resortName && <span className="text-gray-500"> · {e.resortName}</span>}
                  </td>
                  <td className="py-2 text-gray-400">
                    {(e.status === 'rejected' && e.statusNote && REASONS[e.statusNote]) || STATUSES[e.status] || e.status}
                  </td>
                  <td className="py-2 text-gray-400">{e.deviceName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-white font-semibold">Events from an iPad placed somewhere else</h2>
        <p className="text-gray-500 text-sm">
          Counted as normal. Usually an iPad moved between lodges with clock-ins still waiting to send;
          if it keeps happening, check where the iPad is placed under Devices.
        </p>
        {data.mismatches.length === 0 ? (
          <p className="text-gray-500 text-sm">None.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-gray-500 border-b border-gray-800">
              <tr>
                <th className="text-left py-2 font-medium">Patroller</th>
                <th className="text-left py-2 font-medium">Event</th>
                <th className="text-left py-2 font-medium">For</th>
                <th className="text-left py-2 font-medium">iPad, placed at</th>
              </tr>
            </thead>
            <tbody>
              {data.mismatches.map((e) => (
                <tr key={e.id} className="border-b border-gray-900">
                  <td className="py-2 text-white">{e.patrollerName ?? '—'}</td>
                  <td className="py-2 text-gray-300">{e.type === 'clock_in' ? 'In' : 'Out'}, {formatDateTime(e.occurredAt)}</td>
                  <td className="py-2 text-gray-300">{e.resortName ?? '—'}</td>
                  <td className="py-2 text-gray-400">{e.deviceName ?? '—'}, {e.boundResortName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
