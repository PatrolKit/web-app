import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import QRCode from 'react-qr-code';
import { api } from '../../lib/api';
import { DEVICE_ROLES, deviceLabel, deviceRoleLabel } from '../../lib/api.types';
import type { DeviceItem, DeviceRole, ProvisionedDevice } from '../../lib/api.types';

/**
 * Whether the server has heard from a device since a secret was issued to it.
 *
 * Last-seen is stamped when a device trades its client secret for a token, so
 * this is the credentials arriving — not the board's own opinion of itself. A
 * rotation leaves a timestamp from the device's previous life, hence `since`:
 * confirmation waits for it to move rather than merely to exist.
 */
export function useServerConfirmation(orgId: string, deviceId: string, since: string | null) {
  const { data: devices } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    refetchInterval: 2000,
    // Keep polling on a backgrounded tab. Setting a bridge up means watching a
    // board boot and join Wi-Fi, which is exactly when someone switches window —
    // and the default would leave them staring at a screen that stopped asking.
    refetchIntervalInBackground: true,
  });
  const device = devices?.find((d) => d.id === deviceId);
  const seenAt = device?.lastSeenAt ?? null;
  return { device, confirmed: !!seenAt && seenAt !== since };
}

/** The warning before throwing away the only copy of a client secret. */
export const SECRET_LOSS_WARNING =
  'The server has not heard from this device yet.\n\n' +
  'This is the only copy of its client secret — leave now and the secret is gone ' +
  'for good. The device stays, but it cannot be set up again until you issue a ' +
  'new secret from its edit screen.\n\nContinue anyway?';

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
 * The one moment a device's secret exists, and the only place it can be handed
 * over. Everything here follows from that: the card cannot report success it
 * has not seen, and it cannot be dismissed quietly while the secret still
 * matters.
 */
function ProvisioningCodeCard({
  orgId,
  deviceId,
  clientId,
  secret,
  sinceLastSeenAt,
  onDismiss,
}: {
  orgId: string;
  deviceId: string;
  clientId: string;
  secret: string;
  /**
   * What the device's last-seen was when this card opened. A rotation leaves a
   * timestamp from the device's previous life, so confirmation waits for it to
   * move rather than merely to exist — otherwise every rotation would confirm
   * itself instantly against history.
   */
  sinceLastSeenAt: string | null;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const { confirmed } = useServerConfirmation(orgId, deviceId, sinceLastSeenAt);

  function dismiss() {
    if (!confirmed && !window.confirm(SECRET_LOSS_WARNING)) return;
    onDismiss();
  }
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
    <div className={`rounded-lg p-4 border ${
      confirmed ? 'bg-green-900/30 border-green-700' : 'bg-surface-50 border-gray-700'
    }`}>
      {/* Green is a claim about the outcome, so it waits for one. Until the
          server has heard from the device, this card describes unfinished work. */}
      <p className={`font-medium mb-4 ${confirmed ? 'text-green-400' : 'text-white'}`}>
        {confirmed
          ? 'Device set up — the server has heard from it'
          : 'Credentials issued — scan or copy the code now'}
      </p>

      <div className="flex flex-col items-center gap-3">
          <div className="bg-white p-3 rounded">
            <QRCode value={payload} size={200} />
          </div>
          <p className="text-xs text-gray-400">
            {confirmed
              ? 'This device has checked in. Nothing further is needed.'
              : 'Scan with PatrolKit iOS, or copy below. This code is shown once.'}
          </p>
          <button
            onClick={copy}
            className="text-sm bg-brand-500 hover:bg-brand-600 text-white px-6 py-2 rounded w-full max-w-xs transition-colors"
          >
            {copied ? 'Copied!' : 'Copy provisioning code'}
          </button>
      </div>

      <button onClick={dismiss} className="mt-4 text-xs text-gray-500 hover:underline block">Dismiss</button>
    </div>
  );
}


/**
 * Provisioning and credential lifecycle for one module's hardware.
 *
 * Devices used to live on a page of their own, which is how a ski-swap admin
 * ended up unable to reach the printers they were expected to configure. Each
 * module now owns its own, and this is the piece they share: the same provision
 * form, rotate and revoke.
 *
 * One list, one role. Every page that shows this list shows exactly one kind of
 * hardware, so what to create is settled by which page you are on — there is
 * nothing to choose and no role to change afterwards. Provision the wrong thing
 * and you revoke it.
 *
 * The server enforces the same scoping — `ski_swap:admin` may touch ski-swap
 * hardware and nothing else — so `role` here shapes the UI rather than granting
 * anything.
 */
export function DeviceCredentialList({
  orgId,
  role,
  canProvision,
  renderExtra,
  provisionExtra,
  provisionPayload,
  onEdit,
  onProvisioned,
}: {
  orgId: string;
  role: DeviceRole;
  canProvision: boolean;
  /** Extra controls under a device row — the Printers page shows status here. */
  renderExtra?: (device: DeviceItem) => ReactNode;
  /**
   * An extra field in the provision form, and what it adds to the request.
   *
   * Two props rather than one render-prop because the caller owns the state
   * either way: Time Tracking uses this to place a tablet at a resort before it
   * is ever switched on, rather than provisioning it and then remembering.
   */
  provisionExtra?: ReactNode;
  provisionPayload?: Record<string, string | undefined>;
  /**
   * Replaces the row's Edit. Given one, the caller owns editing entirely — a
   * bridge opens a screen where a secret rotation is one option among several,
   * rather than the whole meaning of the button.
   */
  onEdit?: (device: DeviceItem) => void;
  /**
   * Given one, the credential card is skipped and this is handed the brand-new
   * device. A bridge has nothing to show on a card — no QR to scan, nothing to
   * copy — so it goes straight to the screen where it is set up. The secret
   * issued here is not passed on: that screen mints its own at the moment it
   * writes the board.
   */
  onProvisioned?: (device: ProvisionedDevice) => void;
}) {
  const qc = useQueryClient();
  const [provisionName, setProvisionName] = useState('');
  const [showProvisionForm, setShowProvisionForm] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    clientId: string;
    secret: string;
    /** Last-seen before this secret existed, so a rotation cannot confirm itself. */
    sinceLastSeenAt: string | null;
  } | null>(null);

  const { data: allDevices = [], isLoading } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
    // Last-seen is judged against the clock at render, so without a refetch the
    // status freezes at whatever it was when the page loaded. Ten seconds
    // against a twenty-second offline threshold, matching the station card.
    refetchInterval: 10_000,
  });
  const devices = allDevices.filter((d) => d.role === role);
  const roleInfo = DEVICE_ROLES.find((r) => r.value === role);

  const namesItself = role === 'ski_swap.print_bridge';

  const provisionMutation = useMutation({
    mutationFn: () =>
      api.devices.provision(orgId, {
        ...(namesItself ? { role } : { name: provisionName, role }),
        ...(provisionPayload ?? {}),
      }),
    onSuccess: (d) => {
      setProvisionName('');
      setShowProvisionForm(false);
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
      if (onProvisioned) { onProvisioned(d); return; }
      setRevealedSecret({ id: d.id, clientId: d.clientId, secret: d.clientSecret, sinceLastSeenAt: null });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.devices.rotateSecret(orgId, id),
    onSuccess: (d, id) => {
      const device = devices.find((dev) => dev.id === id);
      setRevealedSecret({
        id,
        clientId: device?.clientId ?? '',
        secret: d.clientSecret,
        sinceLastSeenAt: device?.lastSeenAt ?? null,
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.devices.revoke(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['devices', orgId] }),
  });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
          {canProvision && (
            <div className="flex justify-end">
              <button
                onClick={() => {
                  provisionMutation.reset();
                  // Nothing to fill in for a bridge — it is not named, and its
                  // printer is chosen on the screen this opens. A form asking
                  // for nothing is a click in the way.
                  if (namesItself) { provisionMutation.mutate(); return; }
                  setShowProvisionForm(true);
                  setProvisionName('');
                }}
                disabled={provisionMutation.isPending}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40"
              >
                {provisionMutation.isPending ? 'Provisioning…' : `+ Provision ${roleInfo?.label ?? 'Device'}`}
              </button>
            </div>
          )}

          {showProvisionForm && canProvision && (
            <form
              onSubmit={(e) => { e.preventDefault(); provisionMutation.mutate(); }}
              className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
            >
              <h3 className="text-white font-medium">New {roleInfo?.label ?? 'Device'}</h3>
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">Name</span>
                <input
                  value={provisionName}
                  onChange={(e) => setProvisionName(e.target.value)}
                  placeholder="Device name"
                  required
                  className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
                />
              </label>
              {provisionExtra}
              {/* "Network Printer Adapter" says nothing about what the box does
                  or what to do with it next. */}
              <p className="text-xs text-gray-500">{roleInfo?.hint}</p>
              <MutationError error={provisionMutation.error} />
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => { setShowProvisionForm(false); provisionMutation.reset(); }} className="text-sm text-gray-400 hover:text-white px-3 py-2">Cancel</button>
                <button
                  type="submit"
                  disabled={provisionMutation.isPending || !provisionName.trim()}
                  className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
                >
                  {provisionMutation.isPending ? 'Provisioning…' : 'Provision'}
                </button>
              </div>
            </form>
          )}

          {revealedSecret && (
            <ProvisioningCodeCard
              orgId={orgId}
              deviceId={revealedSecret.id}
              clientId={revealedSecret.clientId}
              secret={revealedSecret.secret}
              sinceLastSeenAt={revealedSecret.sinceLastSeenAt}
              onDismiss={() => setRevealedSecret(null)}
            />
          )}

          <MutationError
            error={(showProvisionForm ? null : provisionMutation.error) ?? rotateMutation.error ?? revokeMutation.error}
          />

          <div className="space-y-3">
            {devices.map((d: DeviceItem) => (
              <div key={d.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <span className="font-medium text-white">{deviceLabel(d)}</span>
                  <p className="text-xs text-gray-500 mt-0.5">Client ID: {d.clientId}</p>
                  {d.lastSeenAt ? (
                    <p className="text-xs text-gray-500">Last seen: {new Date(d.lastSeenAt).toLocaleString()}</p>
                  ) : (
                    /* Absence of a timestamp is the whole story for a bridge that
                       was set up over Bluetooth but never reached the server. */
                    <p className="text-xs text-amber-500">Never connected — it has not reached the server</p>
                  )}
                  <p className="text-xs text-gray-400 mt-1">{deviceRoleLabel(d.role)}</p>
                  {renderExtra?.(d)}
                </div>
                <div className="flex gap-2">
                  {canProvision && (
                    <button
                      onClick={() => (onEdit ? onEdit(d) : rotateMutation.mutate(d.id))}
                      className="text-xs text-yellow-500 hover:underline"
                    >Edit</button>
                  )}
                  {canProvision && (
                    <button
                      onClick={() => { if (window.confirm(`Remove "${deviceLabel(d)}"? This permanently deletes the device, and the hardware has to be provisioned again from scratch.`)) revokeMutation.mutate(d.id); }}
                      className="text-xs text-red-500 hover:underline"
                    >Remove</button>
                  )}
                </div>
              </div>
            ))}
            {devices.length === 0 && <p className="text-gray-500 text-sm">No devices provisioned yet.</p>}
          </div>
    </div>
  );
}
