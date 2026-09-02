import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import DevicePinCard from '../../components/DevicePinCard';
import type { TimeTrackingContext } from './TimeTrackingLayout';

export default function SettingsPage() {
  const { orgId } = useOutletContext<TimeTrackingContext>();
  const queryClient = useQueryClient();

  const [error, setError] = useState<string | null>(null);

  const { data: settings } = useQuery({
    queryKey: ['time-clock/settings', orgId],
    queryFn: () => api.timeClock.getSettings(orgId),
  });

  const [localTime, setLocalTime] = useState('03:00');
  const [afterHours, setAfterHours] = useState(4);
  useEffect(() => {
    if (settings) {
      setLocalTime(settings.autoCloseLocalTime);
      setAfterHours(settings.autoCloseAfterHours);
    }
  }, [settings]);

  const settingsMutation = useMutation({
    mutationFn: () =>
      api.timeClock.updateSettings(orgId, { autoCloseLocalTime: localTime, autoCloseAfterHours: afterHours }),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['time-clock/settings', orgId] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="space-y-8">
      {error && <p className="text-red-400 text-sm">{error}</p>}

      <section className="max-w-lg">
        <DevicePinCard
          queryKey={['time-clock/device-pin', orgId]}
          get={() => api.timeClock.getDevicePin(orgId)}
          set={(devicePin) => api.timeClock.setDevicePin(orgId, devicePin)}
          deviceLabel="time clock iPads"
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-white font-semibold">Automatic clock-out</h2>
        <p className="text-gray-400 text-sm max-w-2xl">
          Each iPad sweeps its own resort at this local time and closes any shift still open,
          recording the clock-out at the shift start plus the duration below — or at the sweep
          time, whichever comes first. The server never closes a shift on its own.
        </p>
        <div className="bg-surface-100 rounded-lg p-4 flex flex-wrap gap-3 items-end">
          <label className="text-sm text-gray-300 space-y-1">
            <span className="block">Sweep at (resort local)</span>
            <input type="time" className={inputClass} value={localTime}
              onChange={(e) => setLocalTime(e.target.value)} />
          </label>
          <label className="text-sm text-gray-300 space-y-1">
            <span className="block">Shift length recorded</span>
            <select className={inputClass} value={afterHours}
              onChange={(e) => setAfterHours(Number(e.target.value))}>
              {[2, 3, 4, 5, 6, 8, 10, 12].map((h) => <option key={h} value={h}>{h} hours</option>)}
            </select>
          </label>
          <button onClick={() => settingsMutation.mutate()} disabled={settingsMutation.isPending}
            className="bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded px-3 py-1.5 text-sm">
            Save policy
          </button>
        </div>
      </section>
    </div>
  );
}

const inputClass = 'bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white';
