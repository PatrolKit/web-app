import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'react-qr-code';
import { api } from '../../lib/api';
import {
  currentBaseUrl,
  isProvisionableOrigin,
  isWebBluetoothSupported as isBridgeBluetoothSupported,
  provisionBridge,
  type BridgeStatus,
} from '../../lib/printing/BridgeProvisioningService';
import { DEVICE_ROLES, deviceRoleLabel } from '../../lib/api.types';
import type { DeviceItem, DeviceRole, SwapPrinterRecord } from '../../lib/api.types';

export function MutationError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <p className="text-red-400 text-xs bg-red-950/40 border border-red-900 rounded px-2 py-1.5">
      {message}
    </p>
  );
}

/**
 * Sets a bridge up over Bluetooth: Wi-Fi, which printer to drive, and its own
 * server credentials.
 *
 * Lives on the card that appears right after provisioning or a secret rotation,
 * because that is the only moment the client secret exists — the server never
 * returns it again. Dismiss the card without doing this and the bridge has to be
 * rotated before it can be set up.
 */
function BridgeProvisioningPanel({
  clientId,
  secret,
  printers,
}: {
  clientId: string;
  secret: string;
  printers: SwapPrinterRecord[];
}) {
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [printerName, setPrinterName] = useState(printers[0]?.bluetoothName ?? '');
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const baseUrl = currentBaseUrl();
  const httpsOk = isProvisionableOrigin(baseUrl);
  const supported = isBridgeBluetoothSupported();

  async function run() {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const final = await provisionBridge(
        { ssid: ssid.trim(), psk, printerBluetoothName: printerName, baseUrl, clientId, clientSecret: secret },
        setStatus,
      );
      setStatus(final);
      setDone(true);
    } catch (err) {
      // A cancelled picker is a decision, not a failure.
      if ((err as { name?: string })?.name === 'NotFoundError') return;
      setError(err instanceof Error ? err.message : 'Provisioning failed');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="mt-4 border-t border-green-800 pt-4">
        <p className="text-green-400 text-sm">
          Bridge online{status?.device ? ` — ${status.device}` : ''}. Assign it to a check-in
          station to start printing.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t border-green-800 pt-4 space-y-3 text-left">
      <p className="text-white text-sm font-medium">Set up this bridge over Bluetooth</p>
      <p className="text-xs text-gray-400">
        Hold the board&apos;s BOOT button while powering it on if it has been set up before —
        a bridge that has already reached the server refuses further changes.
      </p>

      {!supported ? (
        <p className="text-amber-400 text-xs">
          Bluetooth setup needs Chrome or Edge. Copy the code above and use the iOS app instead.
        </p>
      ) : !httpsOk ? (
        <p className="text-amber-400 text-xs">
          The bridge only accepts an https server, and this page is on {baseUrl}. Provision from
          the deployed site rather than a local dev server.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Wi-Fi network</span>
              <input
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                placeholder="Network name"
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
            </label>
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Wi-Fi password</span>
              <input
                type="password"
                value={psk}
                onChange={(e) => setPsk(e.target.value)}
                placeholder="Blank if open"
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
            </label>
          </div>

          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Printer this bridge drives</span>
            <select
              value={printerName}
              onChange={(e) => setPrinterName(e.target.value)}
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            >
              {printers.length === 0 && <option value="">No printers registered yet</option>}
              {printers.map((p) => (
                <option key={p.id} value={p.bluetoothName}>{p.name} ({p.bluetoothName})</option>
              ))}
            </select>
          </label>

          {status && !done && (
            <p className="text-xs text-gray-400">{describeBridgeState(status)}</p>
          )}
          {error && <p className="text-red-400 text-xs">{error}</p>}

          <button
            onClick={run}
            disabled={busy || !ssid.trim() || !printerName}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm rounded px-4 py-2"
          >
            {busy ? 'Setting up…' : 'Set up over Bluetooth'}
          </button>
        </>
      )}
    </div>
  );
}

/** The board reports which step it is on; a failure otherwise looks like a slow success. */
function describeBridgeState(status: BridgeStatus): string {
  switch (status.state) {
    case 'wifi_connecting': return 'Joining Wi-Fi…';
    case 'server_connecting': return 'Wi-Fi joined. Reaching the server…';
    case 'online': return 'Online.';
    default: return 'Waiting for the bridge…';
  }
}

function ProvisioningCodeCard({ clientId, secret, role, printers, onDismiss }: { clientId: string; secret: string; role: DeviceRole | null; printers: SwapPrinterRecord[]; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  // A bridge takes its credentials over Bluetooth, so the code is dead weight
  // there. Every other role is an iOS tablet, and the code is the only way it
  // gets provisioned.
  const isBridge = role === 'ski_swap.print_bridge';

  const payload = JSON.stringify({
    v: 1, cid: clientId, sec: secret,
    api: `${window.location.protocol}//${window.location.host}/api/v1`,
  });

  const copy = () => {
    const el = document.createElement('textarea');
    el.value = payload;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    navigator.clipboard?.writeText(payload).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
      <p className="text-green-400 font-medium mb-4">
        {isBridge ? 'Device provisioned — set it up now' : 'Device provisioned — scan or copy the code now'}
      </p>

      {isBridge ? (
        <BridgeProvisioningPanel clientId={clientId} secret={secret} printers={printers} />
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div className="bg-white p-3 rounded">
            <QRCode value={payload} size={200} />
          </div>
          <p className="text-xs text-gray-400">Scan with PatrolKit iOS, or copy below</p>
          <button
            onClick={copy}
            className="text-sm bg-brand-500 hover:bg-brand-600 text-white px-6 py-2 rounded w-full max-w-xs transition-colors"
          >
            {copied ? 'Copied!' : 'Copy provisioning code'}
          </button>
        </div>
      )}

      <button onClick={onDismiss} className="mt-4 text-xs text-gray-500 hover:underline block">Dismiss</button>
    </div>
  );
}


/**
 * Provisioning and credential lifecycle for one module's hardware.
 *
 * Devices used to live on a page of their own, which is how a ski-swap admin
 * ended up unable to reach the printers they were expected to configure. Each
 * module now owns its own, and this is the piece they share: the same provision
 * form, rotate, revoke and role change, scoped to the roles that module uses.
 *
 * The server enforces the same scoping — `ski_swap:admin` may touch ski-swap
 * hardware and nothing else — so `roles` here shapes the UI rather than
 * granting anything.
 */
export function DeviceCredentialList({
  orgId,
  roles,
  printers = [],
  canProvision,
}: {
  orgId: string;
  roles: readonly DeviceRole[];
  /** Only needed where a bridge might be provisioned: it picks a printer. */
  printers?: SwapPrinterRecord[];
  canProvision: boolean;
}) {
  const qc = useQueryClient();
  const [provisionName, setProvisionName] = useState('');
  const [provisionRole, setProvisionRole] = useState<DeviceRole>(roles[0]);
  const [showProvisionForm, setShowProvisionForm] = useState(false);
  const [editingRole, setEditingRole] = useState<{ id: string; value: DeviceRole } | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    clientId: string;
    secret: string;
    /** Decides whether the card offers Bluetooth setup — only a bridge takes it. */
    role: DeviceRole | null;
  } | null>(null);

  const { data: allDevices = [], isLoading } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
  });
  const devices = allDevices.filter((d) => (roles as readonly string[]).includes(d.role));
  const roleOptions = DEVICE_ROLES.filter((r) => (roles as readonly string[]).includes(r.value));

  const provisionMutation = useMutation({
    mutationFn: () => api.devices.provision(orgId, { name: provisionName, role: provisionRole }),
    onSuccess: (d) => {
      setRevealedSecret({ id: d.id, clientId: d.clientId, secret: d.clientSecret, role: provisionRole });
      setProvisionName('');
      setProvisionRole(roles[0]);
      setShowProvisionForm(false);
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.devices.rotateSecret(orgId, id),
    onSuccess: (d, id) => {
      const device = devices.find((dev) => dev.id === id);
      setRevealedSecret({ id, clientId: device?.clientId ?? '', secret: d.clientSecret, role: device?.role ?? null });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.devices.revoke(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['devices', orgId] }),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: DeviceRole }) =>
      api.devices.updateRole(orgId, id, role),
    onSuccess: (updated) => {
      qc.setQueryData<DeviceItem[]>(['devices', orgId], (prev) =>
        prev?.map((d) => (d.id === updated.id ? updated : d)),
      );
      setEditingRole(null);
    },
  });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
          {canProvision && (
            <div className="flex justify-end">
              <button
                onClick={() => { setShowProvisionForm(true); setProvisionName(''); setProvisionRole(roles[0]); provisionMutation.reset(); }}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
              >
                + Provision Device
              </button>
            </div>
          )}

          {showProvisionForm && canProvision && (
            <form
              onSubmit={(e) => { e.preventDefault(); provisionMutation.mutate(); }}
              className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
            >
              <h3 className="text-white font-medium">New Device</h3>
              <input
                value={provisionName}
                onChange={(e) => setProvisionName(e.target.value)}
                placeholder="Device name"
                required
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
              <select
                value={provisionRole}
                onChange={(e) => setProvisionRole(e.target.value as typeof provisionRole)}
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              >
                {roleOptions.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              {/* "Network Printer Adapter" says nothing about what the box does
                  or what to do with it next. */}
              <p className="text-xs text-gray-500">
                {roleOptions.find((r) => r.value === provisionRole)?.hint}
              </p>
              <MutationError error={provisionMutation.error} />
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => { setShowProvisionForm(false); provisionMutation.reset(); }} className="text-sm text-gray-400 hover:text-white px-3 py-2">Cancel</button>
                <button
                  type="submit"
                  disabled={provisionMutation.isPending}
                  className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm"
                >
                  {provisionMutation.isPending ? 'Provisioning…' : 'Provision'}
                </button>
              </div>
            </form>
          )}

          {revealedSecret && (
            <ProvisioningCodeCard
              clientId={revealedSecret.clientId}
              secret={revealedSecret.secret}
              role={revealedSecret.role}
              printers={printers}
              onDismiss={() => setRevealedSecret(null)}
            />
          )}

          <MutationError error={rotateMutation.error ?? revokeMutation.error ?? updateRoleMutation.error} />

          <div className="space-y-3">
            {devices.map((d: DeviceItem) => (
              <div key={d.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <span className="font-medium text-white">{d.name}</span>
                  <p className="text-xs text-gray-500 mt-0.5">Client ID: {d.clientId}</p>
                  {d.lastSeenAt && <p className="text-xs text-gray-500">Last seen: {new Date(d.lastSeenAt).toLocaleString()}</p>}
                  {editingRole?.id === d.id ? (
                    <div className="flex items-center gap-1 mt-1">
                      <select
                        autoFocus
                        value={editingRole.value}
                        onChange={(e) => setEditingRole({ id: d.id, value: e.target.value as typeof editingRole.value })}
                        className="text-xs bg-surface-100 border border-gray-600 rounded px-2 py-0.5 text-white"
                      >
                        {roleOptions.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                      <button onClick={() => updateRoleMutation.mutate({ id: d.id, role: editingRole.value })} disabled={updateRoleMutation.isPending} className="text-xs text-green-400 hover:underline">Save</button>
                      <button onClick={() => setEditingRole(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-xs text-gray-400">{deviceRoleLabel(d.role)}</span>
                      {canProvision && (
                        <button onClick={() => setEditingRole({ id: d.id, value: d.role })} className="text-xs text-gray-600 hover:text-gray-400" aria-label="Edit role">✎</button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {canProvision && (
                    <button onClick={() => rotateMutation.mutate(d.id)} className="text-xs text-yellow-500 hover:underline">Rotate</button>
                  )}
                  {canProvision && (
                    <button
                      onClick={() => { if (window.confirm(`Revoke "${d.name}"? This will permanently remove the device and it will need to be re-provisioned.`)) revokeMutation.mutate(d.id); }}
                      className="text-xs text-red-500 hover:underline"
                    >Revoke</button>
                  )}
                </div>
              </div>
            ))}
            {devices.length === 0 && <p className="text-gray-500 text-sm">No devices provisioned yet.</p>}
          </div>
    </div>
  );
}
