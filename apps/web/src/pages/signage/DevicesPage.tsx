import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeviceCredentialList } from '../devices/DeviceCredentials';
import SetupDisplayModal from './SetupDisplayModal';
import { api } from '../../lib/api';
import type { DeviceItem, DeviceRole } from '../../lib/api.types';

const SIGNAGE_ROLE: DeviceRole = 'signage.display';

const selectClass =
  'bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white disabled:opacity-40';

/**
 * What a display last told us it was running.
 *
 * Separate from "last seen", which only proves credentials arrived. A screen
 * can hold valid credentials, check in on schedule, and be running the wrong
 * version — or nothing at all — and this row is the only place that shows.
 */
function CheckIn({ device }: { device: DeviceItem }) {
  if (!device.bootstrapAt) {
    return (
      <p className="text-xs text-amber-500 mt-1">
        Has not asked what to run — set it up over Bluetooth, or check it can reach the internet
      </p>
    );
  }

  const packages = (device.installedPackages ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="text-xs text-gray-500 mt-1 space-y-0.5">
      <p>
        Image: {device.imageName ?? 'unknown'} {device.imageVersion ?? ''}
        {device.hardwareId ? ` · ${device.hardwareId}` : ''}
      </p>
      <p>
        {packages.length > 0 ? `Running: ${packages.join(', ')}` : 'Running: nothing yet'}
        {' · '}
        checked in {new Date(device.bootstrapAt).toLocaleString()}
      </p>
    </div>
  );
}

/**
 * The screens in patrol rooms.
 *
 * Signage hardware, so it lives with signage. The server scopes these to
 * `signage:manage` by the device's own role, so a ski-swap admin sees none of
 * them.
 */
export default function SignageDevicesPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const canManage = perms.has('signage:manage');

  // The module gate upstream guarantees at least one, so this list is never
  // the empty case a picker would have to explain.
  const { data: resorts = [] } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  /**
   * Chosen in the provision form, and required there. A display with no resort
   * is a dark screen, which is indistinguishable from a broken one — unlike a
   * time-clock tablet, which can sit unbound and say so.
   */
  const [newResortId, setNewResortId] = useState('');

  /**
   * The display being written over Bluetooth, by id.
   *
   * A brand-new one goes straight here rather than through the credential card:
   * there is no QR for a screen to scan and nothing for anyone to copy, and the
   * secret that ends up on the device is minted by the modal at the moment it
   * writes rather than being carried across from provisioning.
   *
   * By id, and resolved against the list below, because the provision response
   * carries only what the server just wrote — no resort, no check-in. The modal
   * writes the resort into the device's `app_payload`, so handing it the
   * response directly wrote `resortId: undefined` onto hardware while the page
   * behind it showed the resort correctly.
   */
  const [setupTargetId, setSetupTargetId] = useState<string | null>(null);

  // The same cached query `DeviceCredentialList` runs, so this costs nothing
  // and never disagrees with the row the button was pressed on. A device
  // provisioned a moment ago may not be on it yet; the modal opens anyway and
  // refuses to write until it is.
  const { data: devices = [] } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
  });
  const setupTarget = devices.find((d) => d.id === setupTargetId) ?? null;

  const bind = useMutation({
    mutationFn: ({ id, resortId }: { id: string; resortId: string | null }) =>
      api.devices.bindResort(orgId, id, resortId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devices', orgId] }),
  });

  return (
    <div className="space-y-4">
      <DeviceCredentialList
        orgId={orgId}
        role={SIGNAGE_ROLE}
        canProvision={canManage}
        onProvisioned={(d) => setSetupTargetId(d.id)}
        onEdit={(d) => setSetupTargetId(d.id)}
        editLabel="Set up"
        provisionPayload={{ resortId: newResortId || undefined }}
        provisionReady={!!newResortId}
        provisionExtra={
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Resort</span>
            <select
              value={newResortId}
              onChange={(e) => setNewResortId(e.target.value)}
              className={`${selectClass} w-full`}
              required
            >
              {/* No "choose later": the server refuses one, and offering it here
                  would mean explaining the refusal after the fact. */}
              <option value="">Select a resort…</option>
              {resorts.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
        }
        renderExtra={(device: DeviceItem) => (
          <div className="space-y-1 mt-1">
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
                    screen is taken down without revoking its credentials. */}
                <option value="">Not placed</option>
                {resorts.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
            <CheckIn device={device} />
          </div>
        )}
      />
      {bind.error && (
        <p className="text-sm text-red-400">
          {bind.error instanceof Error ? bind.error.message : 'Could not change the resort'}
        </p>
      )}

      {setupTarget && (
        <SetupDisplayModal
          orgId={orgId}
          device={setupTarget}
          onClose={() => {
            setSetupTargetId(null);
            // A display that just came online has a fresh check-in to show.
            qc.invalidateQueries({ queryKey: ['devices', orgId] });
          }}
        />
      )}
    </div>
  );
}
