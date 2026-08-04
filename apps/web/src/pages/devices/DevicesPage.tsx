import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { api } from '../../lib/api';
import type { DeviceItem } from '../../lib/api.types';

export default function DevicesPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const [provisionName, setProvisionName] = useState('');
  const [provisionRole, setProvisionRole] = useState('');
  const [editingRole, setEditingRole] = useState<{ id: string; value: string } | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    clientId: string;
    secret: string;
  } | null>(null);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
  });

  const provisionMutation = useMutation({
    mutationFn: () =>
      api.devices.provision(orgId, {
        name: provisionName,
        role: provisionRole.trim() || null,
        permissions: [],
      }),
    onSuccess: (d) => {
      setRevealedSecret({ id: d.id, clientId: d.clientId, secret: d.clientSecret });
      setProvisionName('');
      setProvisionRole('');
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.devices.rotateSecret(orgId, id),
    onSuccess: (d, id) => {
      const device = devices.find((dev) => dev.id === id);
      setRevealedSecret({ id, clientId: device?.clientId ?? '', secret: d.clientSecret });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.devices.revoke(orgId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices', orgId] }),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string | null }) =>
      api.devices.updateRole(orgId, id, role),
    onSuccess: (updated) => {
      qc.setQueryData<DeviceItem[]>(['devices', orgId], (prev) =>
        prev?.map((d) => (d.id === updated.id ? updated : d)),
      );
      setEditingRole(null);
    },
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Devices</h1>

      {perms.has('devices:provision') && (
        <form onSubmit={(e) => { e.preventDefault(); provisionMutation.mutate(); }} className="space-y-2">
          <div className="flex gap-2">
            <input value={provisionName} onChange={(e) => setProvisionName(e.target.value)}
              placeholder="Device name" required
              className="flex-1 bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
            <button type="submit" disabled={provisionMutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm">
              Provision
            </button>
          </div>
          <input value={provisionRole} onChange={(e) => setProvisionRole(e.target.value)}
            placeholder='Role — e.g. "SkiSwap Check-in"'
            className="w-full bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
        </form>
      )}

      {/* Show-secret-once modal */}
      {revealedSecret && (
        <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
          <p className="text-green-400 font-medium mb-3">Client secret (shown once — copy or scan now)</p>
          <div className="flex gap-6">
            <div className="flex flex-col items-center gap-2">
              <p className="text-xs text-gray-400">Scan with PatrolKit iOS to provision</p>
              <div className="bg-white p-2 rounded">
                <QRCode
                  value={JSON.stringify({
                    v: 1,
                    cid: revealedSecret.clientId,
                    sec: revealedSecret.secret,
                    api: 'https://patrolkit.io/api/v1',
                  })}
                  size={200}
                />
              </div>
            </div>
            <div className="flex-1 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm text-white bg-surface-100 rounded px-3 py-2 break-all">{revealedSecret.secret}</code>
                <button onClick={() => navigator.clipboard.writeText(revealedSecret.secret)}
                  className="text-xs bg-surface-100 hover:bg-surface-200 text-gray-300 px-3 py-2 rounded whitespace-nowrap">
                  Copy
                </button>
              </div>
            </div>
          </div>
          <button onClick={() => setRevealedSecret(null)} className="mt-3 text-xs text-gray-500 hover:underline">Dismiss</button>
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
              {editingRole?.id === d.id ? (
                <div className="flex items-center gap-1 mt-1">
                  <input
                    autoFocus
                    value={editingRole.value}
                    onChange={(e) => setEditingRole({ id: d.id, value: e.target.value })}
                    className="text-xs bg-surface-100 border border-gray-600 rounded px-2 py-0.5 text-white w-40"
                  />
                  <button
                    onClick={() => updateRoleMutation.mutate({ id: d.id, role: editingRole.value.trim() || null })}
                    disabled={updateRoleMutation.isPending}
                    className="text-xs text-green-400 hover:underline"
                  >Save</button>
                  <button onClick={() => setEditingRole(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                </div>
              ) : (
                <div className="flex items-center gap-1 mt-1">
                  <span className={`text-xs ${d.role ? 'text-gray-400' : 'text-gray-600'}`}>{d.role ?? 'No role'}</span>
                  {perms.has('devices:provision') && d.status === 'active' && (
                    <button onClick={() => setEditingRole({ id: d.id, value: d.role ?? '' })}
                      className="text-xs text-gray-600 hover:text-gray-400" aria-label="Edit role">✎</button>
                  )}
                </div>
              )}
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
