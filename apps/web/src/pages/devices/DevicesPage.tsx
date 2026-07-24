import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import type { DeviceItem } from '../../lib/api.types';

export default function DevicesPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const [provisionName, setProvisionName] = useState('');
  const [revealedSecret, setRevealedSecret] = useState<{ id: string; secret: string } | null>(null);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
  });

  const provisionMutation = useMutation({
    mutationFn: () => api.devices.provision(orgId, { name: provisionName, permissions: [] }),
    onSuccess: (d) => {
      setRevealedSecret({ id: d.id, secret: d.clientSecret });
      setProvisionName('');
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.devices.rotateSecret(orgId, id),
    onSuccess: (d, id) => setRevealedSecret({ id, secret: d.clientSecret }),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.devices.revoke(orgId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices', orgId] }),
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Devices</h1>

      {perms.has('devices:provision') && (
        <form onSubmit={(e) => { e.preventDefault(); provisionMutation.mutate(); }} className="flex gap-2">
          <input value={provisionName} onChange={(e) => setProvisionName(e.target.value)}
            placeholder="Device name" required
            className="flex-1 bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          <button type="submit" disabled={provisionMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm">
            Provision
          </button>
        </form>
      )}

      {/* Show-secret-once modal */}
      {revealedSecret && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
          <p className="text-green-400 font-medium mb-2">Client secret (shown once — copy now)</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-sm text-white bg-surface-100 rounded px-3 py-2 break-all">{revealedSecret.secret}</code>
            <button onClick={() => navigator.clipboard.writeText(revealedSecret.secret)}
              className="text-xs bg-surface-100 hover:bg-surface-200 text-gray-300 px-3 py-2 rounded whitespace-nowrap">
              Copy
            </button>
          </div>
          <button onClick={() => setRevealedSecret(null)} className="mt-2 text-xs text-gray-500 hover:underline">Dismiss</button>
        </div>
      )}

      <div className="space-y-3">
        {devices.map((d: DeviceItem) => (
          <div key={d.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-white">{d.name}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${d.status === 'active' ? 'bg-green-900 text-green-400' : 'bg-red-900 text-red-400'}`}>{d.status}</span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">Client ID: {d.clientId}</p>
              {d.lastSeenAt && <p className="text-xs text-gray-500">Last seen: {new Date(d.lastSeenAt).toLocaleString()}</p>}
            </div>
            <div className="flex gap-2">
              {perms.has('devices:provision') && d.status === 'active' && (
                <button onClick={() => rotateMutation.mutate(d.id)}
                  className="text-xs text-yellow-500 hover:underline">Rotate</button>
              )}
              {perms.has('devices:revoke') && d.status === 'active' && (
                <button onClick={() => revokeMutation.mutate(d.id)}
                  className="text-xs text-red-500 hover:underline">Revoke</button>
              )}
            </div>
          </div>
        ))}
        {devices.length === 0 && <p className="text-gray-500 text-sm">No devices provisioned yet.</p>}
      </div>
    </div>
  );
}
