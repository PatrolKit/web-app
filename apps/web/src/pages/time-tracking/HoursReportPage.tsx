import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TimeTrackingContext } from './TimeTrackingLayout';

const DUTY_TYPES = ['patrol', 'training', 'instruction', 'other'];

export default function HoursReportPage() {
  const { orgId } = useOutletContext<TimeTrackingContext>();

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [resortId, setResortId] = useState('');

  const { data: resorts = [] } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
  });

  const params = {
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
    resortId: resortId || undefined,
  };

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['time-clock/hours', orgId, params],
    queryFn: () => api.timeClock.hours(orgId, params),
  });

  const csvHref = (() => {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, String(v)); });
    return `/api/v1/orgs/${orgId}/time-clock/reports/hours.csv${qs.toString() ? `?${qs}` : ''}`;
  })();

  const hours = (minutes: number) => (minutes / 60).toFixed(1);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} />
        <select className={inputClass} value={resortId} onChange={(e) => setResortId(e.target.value)}>
          <option value="">All resorts</option>
          {resorts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <span className="flex-1" />
        <a href={csvHref} className="text-sm text-red-400 hover:text-red-300">↓ Export CSV</a>
      </div>

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-gray-500 text-sm py-8 text-center">No closed shifts in this range.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-gray-500 border-b border-gray-800">
            <tr>
              <th className="text-left py-2 font-medium">Patroller</th>
              <th className="text-left py-2 font-medium">NSP ID</th>
              <th className="text-right py-2 font-medium">Shifts</th>
              <th className="text-right py-2 font-medium">Total</th>
              {DUTY_TYPES.map((d) => (
                <th key={d} className="text-right py-2 font-medium capitalize">{d}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.patrollerId} className="border-b border-gray-900">
                <td className="py-2 text-white">
                  {row.patrollerName}
                  {row.patrolLevel && <span className="text-gray-500 text-xs ml-2">{row.patrolLevel}</span>}
                </td>
                <td className="py-2 text-gray-400 tabular-nums">{row.nspId}</td>
                <td className="py-2 text-gray-300 text-right tabular-nums">{row.shiftCount}</td>
                <td className="py-2 text-white text-right tabular-nums">{hours(row.totalMinutes)}h</td>
                {DUTY_TYPES.map((d) => (
                  <td key={d} className="py-2 text-gray-400 text-right tabular-nums">
                    {row.minutesByDutyType[d] ? `${hours(row.minutesByDutyType[d])}h` : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const inputClass = 'bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white';
