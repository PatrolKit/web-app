import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeviceCredentialList } from '../devices/DeviceCredentials';
import { api } from '../../lib/api';
import type { DeviceItem, DeviceRole } from '../../lib/api.types';

const TIME_CLOCK_ROLE: DeviceRole = 'time_clock.terminal';

const selectClass =
  'bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white disabled:opacity-40';

/**
 * The tablets patrollers clock in and out on.
 *
 * Time-tracking hardware, so it lives with time tracking. The server scopes
 * these to `time_tracking:manage` by the device's own role, so a ski-swap admin
 * sees none of them.
 */
export default function TimeClockDevicesPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const canManage = perms.has('time_tracking:manage');

  // The module gate upstream guarantees at least one, so this list is never
  // the empty case a picker would have to explain.
  const { data: resorts = [] } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  /** Chosen in the provision form, so a tablet is placed before it is switched on. */
  const [newResortId, setNewResortId] = useState('');

  const bind = useMutation({
    mutationFn: ({ id, resortId }: { id: string; resortId: string | null }) =>
      api.devices.bindResort(orgId, id, resortId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices', orgId] }),
  });

  return (
    <div className="space-y-4">
      <DeviceCredentialList
        orgId={orgId}
        role={TIME_CLOCK_ROLE}
        canProvision={canManage}
        provisionPayload={{ resortId: newResortId || undefined }}
        provisionExtra={
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Resort</span>
            <select
              value={newResortId}
              onChange={(e) => setNewResortId(e.target.value)}
              className={`${selectClass} w-full`}
            >
              <option value="">Choose later</option>
              {resorts.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
        }
        renderExtra={(device: DeviceItem) => (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Resort</span>
            <select
              value={device.resortId ?? ''}
              disabled={!canManage || bind.isPending}
              onChange={(e) =>
                bind.mutate({ id: device.id, resortId: e.target.value || null })
              }
              className={selectClass}
            >
              {/* Unbinding is a real choice, not a placeholder: it is how a
                  tablet is put away without revoking its credentials. */}
              <option value="">Not placed</option>
              {resorts.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
        )}
      />
      {bind.error && (
        <p className="text-sm text-red-400">
          {bind.error instanceof Error ? bind.error.message : 'Could not change the resort'}
        </p>
      )}
    </div>
  );
}
