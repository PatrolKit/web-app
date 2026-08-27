import { useEffect, useState, type ReactNode } from 'react';
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
 *
 * `confirmed` comes from the server having authenticated the bridge, and it is
 * the only thing here that reports success. The board's own `online` is a claim
 * about itself: a bridge that joins Wi-Fi and then cannot reach the server —
 * wrong clock, rejected TLS, a firmware bug in the token exchange — says
 * `online` and stays silent, and taking it at its word is what made a dead
 * bridge look provisioned.
 */
function BridgeProvisioningPanel({
  clientId,
  secret,
  printers,
  confirmed,
}: {
  clientId: string;
  secret: string;
  printers: SwapPrinterRecord[];
  confirmed: boolean;
}) {
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [printerName, setPrinterName] = useState(printers[0]?.bluetoothName ?? '');
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The board reported `online`. Says nothing about the server yet. */
  const [boardOnline, setBoardOnline] = useState(false);
  /** The board has claimed online for long enough that silence is a diagnosis. */
  const [serverOverdue, setServerOverdue] = useState(false);

  // A bridge that is going to reach the server does so within a couple of
  // seconds of joining Wi-Fi. Waiting longer than this and still hearing
  // nothing is the failure, not a slow start.
  useEffect(() => {
    if (!boardOnline || confirmed) return;
    const t = setTimeout(() => setServerOverdue(true), 20_000);
    return () => clearTimeout(t);
  }, [boardOnline, confirmed]);

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
      setBoardOnline(true);
    } catch (err) {
      // A cancelled picker is a decision, not a failure.
      if ((err as { name?: string })?.name === 'NotFoundError') return;
      setError(err instanceof Error ? err.message : 'Provisioning failed');
    } finally {
      setBusy(false);
    }
  }

  if (confirmed) {
    return (
      <div className="mt-4 border-t border-green-800 pt-4">
        <p className="text-green-400 text-sm">
          Bridge online{status?.device ? ` — ${status.device}` : ''}, and the server has heard
          from it. Bind it to a printer above, then to a check-in station.
        </p>
      </div>
    );
  }

  // The board joined Wi-Fi and went quiet. This is the one failure the old
  // panel reported as success, so it says exactly what is and is not known.
  if (boardOnline && serverOverdue) {
    return (
      <div className="mt-4 border-t border-amber-800 pt-4 space-y-2">
        <p className="text-amber-400 text-sm font-medium">
          The board says it is online, but the server has never heard from it.
        </p>
        <p className="text-xs text-gray-400">
          Wi-Fi worked — the failure is after that, when the bridge exchanges its client
          secret for a token. Check the firmware build, and that the board&apos;s clock is
          set, since TLS rejects a certificate that looks expired from the board&apos;s
          point of view.
        </p>
        <p className="text-xs text-gray-400">
          This device is kept, not discarded: if it does reach the server later, it starts
          working on its own and the list stops saying &quot;never connected&quot;. To try
          again now, hold BOOT while powering the board on and set it up once more.
        </p>
        <button
          onClick={() => { setBoardOnline(false); setServerOverdue(false); setStatus(null); }}
          className="text-xs text-brand-500 hover:underline"
        >
          Try setting it up again
        </button>
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

          {boardOnline ? (
            <p className="text-xs text-gray-400">
              Wi-Fi joined. Waiting for the server to hear from the bridge…
            </p>
          ) : status ? (
            <p className="text-xs text-gray-400">{describeBridgeState(status)}</p>
          ) : null}
          {error && <p className="text-red-400 text-xs">{error}</p>}

          <button
            onClick={run}
            disabled={busy || boardOnline || !ssid.trim() || !printerName}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm rounded px-4 py-2"
          >
            {busy ? 'Setting up…' : boardOnline ? 'Waiting for the server…' : 'Set up over Bluetooth'}
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
  role,
  printers,
  sinceLastSeenAt,
  onDismiss,
}: {
  orgId: string;
  deviceId: string;
  clientId: string;
  secret: string;
  role: DeviceRole | null;
  printers: SwapPrinterRecord[];
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

  // The server stamps last-seen when a device trades its client secret for a
  // token, so this is the credentials arriving — not the board's opinion of
  // itself. Polling stops as soon as that happens.
  const { data: devices } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    refetchInterval: 2000,
    // Keep polling on a backgrounded tab. Setting a bridge up means watching a
    // board boot and join Wi-Fi, which is exactly when someone switches window —
    // and the default would leave them staring at a card that stopped asking.
    refetchIntervalInBackground: true,
  });
  const seenAt = devices?.find((d) => d.id === deviceId)?.lastSeenAt ?? null;
  const confirmed = !!seenAt && seenAt !== sinceLastSeenAt;

  function dismiss() {
    if (
      !confirmed &&
      !window.confirm(
        'The server has not heard from this device yet.\n\n' +
          'This card holds the only copy of its client secret — dismiss it and the ' +
          'secret is gone for good. The device stays, but it cannot be set up again ' +
          'until you Edit it for a new secret.\n\nDismiss anyway?',
      )
    ) return;
    onDismiss();
  }
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
    <div className={`rounded-lg p-4 border ${
      confirmed ? 'bg-green-900/30 border-green-700' : 'bg-surface-50 border-gray-700'
    }`}>
      {/* Green is a claim about the outcome, so it waits for one. Until the
          server has heard from the device, this card describes unfinished work. */}
      <p className={`font-medium mb-4 ${confirmed ? 'text-green-400' : 'text-white'}`}>
        {confirmed
          ? 'Device set up — the server has heard from it'
          : isBridge
            ? 'Credentials issued — set the bridge up now'
            : 'Credentials issued — scan or copy the code now'}
      </p>

      {isBridge ? (
        <BridgeProvisioningPanel clientId={clientId} secret={secret} printers={printers} confirmed={confirmed} />
      ) : (
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
      )}

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
  printers = [],
  canProvision,
  renderExtra,
}: {
  orgId: string;
  role: DeviceRole;
  /** Only needed where a bridge might be provisioned: it picks a printer. */
  printers?: SwapPrinterRecord[];
  canProvision: boolean;
  /** Extra controls under a device row — the Printers page binds a printer here. */
  renderExtra?: (device: DeviceItem) => ReactNode;
}) {
  const qc = useQueryClient();
  const [provisionName, setProvisionName] = useState('');
  const [showProvisionForm, setShowProvisionForm] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    clientId: string;
    secret: string;
    /** Decides whether the card offers Bluetooth setup — only a bridge takes it. */
    role: DeviceRole | null;
    /** Last-seen before this secret existed, so a rotation cannot confirm itself. */
    sinceLastSeenAt: string | null;
  } | null>(null);

  const { data: allDevices = [], isLoading } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
  });
  const devices = allDevices.filter((d) => d.role === role);
  const roleInfo = DEVICE_ROLES.find((r) => r.value === role);

  const provisionMutation = useMutation({
    mutationFn: () => api.devices.provision(orgId, { name: provisionName, role }),
    onSuccess: (d) => {
      setRevealedSecret({ id: d.id, clientId: d.clientId, secret: d.clientSecret, role, sinceLastSeenAt: null });
      setProvisionName('');
      setShowProvisionForm(false);
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
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
        role: device?.role ?? null,
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
                onClick={() => { setShowProvisionForm(true); setProvisionName(''); provisionMutation.reset(); }}
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
              {/* "Network Printer Adapter" says nothing about what the box does
                  or what to do with it next. */}
              <p className="text-xs text-gray-500">{roleInfo?.hint}</p>
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
              orgId={orgId}
              deviceId={revealedSecret.id}
              clientId={revealedSecret.clientId}
              secret={revealedSecret.secret}
              role={revealedSecret.role}
              printers={printers}
              sinceLastSeenAt={revealedSecret.sinceLastSeenAt}
              onDismiss={() => setRevealedSecret(null)}
            />
          )}

          <MutationError error={rotateMutation.error ?? revokeMutation.error} />

          <div className="space-y-3">
            {devices.map((d: DeviceItem) => (
              <div key={d.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <span className="font-medium text-white">{d.name}</span>
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
                    <button onClick={() => rotateMutation.mutate(d.id)} className="text-xs text-yellow-500 hover:underline">Edit</button>
                  )}
                  {canProvision && (
                    <button
                      onClick={() => { if (window.confirm(`Remove "${d.name}"? This permanently deletes the device, and the hardware has to be provisioned again from scratch.`)) revokeMutation.mutate(d.id); }}
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
