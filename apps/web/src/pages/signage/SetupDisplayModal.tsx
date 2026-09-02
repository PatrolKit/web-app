import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  BadPinError,
  ImageProvisioningSession,
  PinRequiredError,
  currentBaseUrl,
  describeError,
  describeState,
  isProvisionableOrigin,
  isWebBluetoothSupported,
  type ImageStatus,
  type WifiNetwork,
} from '../../lib/provisioning/ImageProvisioningService';
import type { DeviceItem } from '../../lib/api.types';

type Step = 'intro' | 'pin' | 'network' | 'working' | 'done';

const input = 'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm';
const label = 'block text-xs text-gray-400 mb-1';

/**
 * Setting a display up over Bluetooth.
 *
 * The order is the protocol's, not a design choice: the screen has to be
 * reclaimed before anyone can read the PIN, the PIN has to unlock the
 * connection before any credential can be written, and the Wi-Fi scan has to
 * arrive before the form is submitted.
 */
export default function SetupDisplayModal({
  orgId,
  device,
  onClose,
}: {
  orgId: string;
  device: DeviceItem;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>('intro');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ImageStatus | null>(null);
  const [networks, setNetworks] = useState<WifiNetwork[]>([]);
  const [pin, setPin] = useState('');
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');
  const [committed, setCommitted] = useState(false);
  const [rebooted, setRebooted] = useState(false);
  /**
   * The device's last check-in when the commit was written.
   *
   * Confirmation waits for it to *move*, not merely to exist: a display being
   * re-provisioned already has one from its previous life, and comparing
   * against history would confirm every re-provision instantly.
   */
  const [checkedInSince, setCheckedInSince] = useState<string | null>(null);
  /** Long enough to be worth explaining, short enough to still be watching. */
  const [waitingTooLong, setWaitingTooLong] = useState(false);

  /**
   * Whether the server has heard from the display since the commit.
   *
   * This — not the Bluetooth link — is what says provisioning worked. The
   * device installs, seals and reboots itself, so the radio goes away long
   * before it is finished; a check-in proves the credentials, the network and
   * the route to us, which is everything the write was for.
   */
  const { data: devices } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: step === 'working',
    refetchInterval: 2000,
    // Setting a display up means walking over to look at it, which is exactly
    // when this tab stops being frontmost.
    refetchIntervalInBackground: true,
  });
  const live = devices?.find((d) => d.id === device.id);
  const checkedIn = !!live?.bootstrapAt && live.bootstrapAt !== checkedInSince;

  const session = useRef<ImageProvisioningSession | null>(null);

  // The radio is a shared, single-user resource: a session left open blocks the
  // next display, and there is no other owner to clean it up.
  useEffect(() => () => session.current?.close(), []);

  // Success: the server heard from it. Failure: the device said why, over a
  // link that is still up — a refused Wi-Fi password is certain in seconds,
  // where waiting for a check-in that will never come takes minutes.
  useEffect(() => {
    if (step !== 'working') return;
    if (checkedIn) setStep('done');
    else if (status?.error) setError(describeError(status.error));
  }, [step, checkedIn, status?.error]);

  // Not a timeout: nothing is cancelled and the poll keeps running, because a
  // device on a slow link can genuinely take this long and giving up on it
  // would be wrong. It just stops looking like nothing is happening.
  useEffect(() => {
    if (step !== 'working') return;
    const timer = setTimeout(() => setWaitingTooLong(true), 180_000);
    return () => clearTimeout(timer);
  }, [step]);

  const baseUrl = currentBaseUrl();
  const httpsOk = isProvisionableOrigin(baseUrl);
  const supported = isWebBluetoothSupported();

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        // The browser's device chooser was dismissed. Not a failure.
        setError(null);
      } else if (err instanceof PinRequiredError || err instanceof BadPinError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      }
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    run(async () => {
      const opened = await ImageProvisioningSession.open();
      session.current = opened;
      opened.onStatus(setStatus);
      await opened.showPin();
      setStep('pin');
    });

  const unlock = () =>
    run(async () => {
      await session.current!.unlock(pin);
      setPin('');
      // Seeded from what the device already has, so a re-provision that only
      // changes the password does not need the network name retyped.
      const current = session.current!.currentStatus;
      if (current?.ssid && !ssid) setSsid(current.ssid);
      setNetworks(await session.current!.readNetworks());
      setStep('network');
    });

  const rescan = () =>
    run(async () => {
      setNetworks(await session.current!.rescan());
    });

  const showPinAgain = () => run(async () => session.current!.showPin());

  const commit = () =>
    run(async () => {
      if (!device.resortId) {
        // The application reads its resort out of `app_payload` and there is no
        // second chance to send one — every provisioning characteristic is
        // write-only. Writing `undefined` here produced a display that came
        // online, checked in, and belonged nowhere.
        throw new Error('Give this display a resort before setting it up.');
      }
      setStep('working');
      // Minted at the moment of the write (never before), because this is the
      // only copy that will ever exist and it is going straight onto the device.
      const { clientSecret } = await api.devices.rotateSecret(orgId, device.id);

      setCheckedInSince(device.bootstrapAt);
      // The link will drop when the device reboots itself after sealing. That
      // is the expected end of this connection, not a failure.
      session.current!.onDisconnect(() => setRebooted(true));

      await session.current!.commit(
        {
          ssid,
          psk,
          baseUrl,
          clientId: device.clientId,
          clientSecret,
          // The base image copies this to disk verbatim and never reads it. The
          // credentials are repeated here because every provisioning
          // characteristic is write-only — this is the application's only way
          // to learn who it is.
          appPayload: {
            baseUrl,
            clientId: device.clientId,
            clientSecret,
            orgId,
            deviceId: device.id,
            resortId: device.resortId,
          },
        },
        { onCommitted: () => setCommitted(true) },
      );
    });

  const factoryReset = () =>
    run(async () => {
      if (
        !window.confirm(
          'Erase this display’s Wi-Fi and credentials and reboot it into setup mode?\n\n' +
            'Installed software is left alone. You will need to set it up again from scratch.',
        )
      ) {
        return;
      }
      await session.current!.factoryReset();
      onClose();
    });

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-medium">Set up {device.name}</h2>
            <p className="text-xs text-gray-500">
              {device.resortName ?? 'Not placed'} · over Bluetooth, from this browser
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-sm">Close</button>
        </div>

        {!supported && (
          <Notice tone="red">
            Setting up a display needs Web Bluetooth, which only Chrome and Edge have. Safari and
            Firefox cannot do it at all.
          </Notice>
        )}
        {supported && !httpsOk && (
          <Notice tone="red">
            The display refuses any server address that is not https, and this page is served from{' '}
            <span className="font-mono">{baseUrl}</span>. Set displays up from the deployed site
            rather than a local dev server.
          </Notice>
        )}

        {status && (
          <p className="text-xs text-gray-400">
            {status.device ? `${status.device} · ` : ''}
            {describeState(status)}
            {status.imageVersion ? ` · image ${status.imageVersion}` : ''}
          </p>
        )}

        {step === 'intro' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-300">
              Switch the display on and stand where you can see it. Choosing it below makes it
              interrupt whatever it is showing and put a six-digit PIN on the screen.
            </p>
            <p className="text-xs text-gray-500">
              The PIN is what proves you are in front of the display. It is the only thing
              protecting it, so it is not written down anywhere and cannot be looked up.
            </p>
            <button
              onClick={connect}
              disabled={busy || !supported || !httpsOk}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
            >
              {busy ? 'Looking…' : 'Choose a display'}
            </button>
          </div>
        )}

        {step === 'pin' && (
          <form onSubmit={(e) => { e.preventDefault(); unlock(); }} className="space-y-3">
            <label className="block">
              <span className={label}>The six digits on the screen</span>
              <input
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                inputMode="numeric"
                placeholder="123456"
                className={`${input} font-mono tracking-widest text-lg`}
              />
            </label>
            {status?.pinExposed && (
              <Notice tone="amber">
                This display is a bench build that mirrors its PIN to a file. It must never be
                installed at a resort.
              </Notice>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={busy || pin.replace(/\D/g, '').length < 4}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
              >
                {busy ? 'Checking…' : 'Unlock'}
              </button>
              <button
                type="button"
                onClick={showPinAgain}
                disabled={busy}
                className="text-xs text-brand-400 hover:underline"
              >
                Show the PIN again
              </button>
            </div>
            <p className="text-xs text-gray-500">
              After three wrong tries the display locks setup for a minute and shows a different
              PIN — read the new one off the screen rather than retyping the old.
            </p>
          </form>
        )}

        {step === 'network' && (
          <form onSubmit={(e) => { e.preventDefault(); commit(); }} className="space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <span className={label}>Network</span>
                <button type="button" onClick={rescan} disabled={busy} className="text-xs text-brand-400 hover:underline">
                  {busy ? 'Scanning…' : 'Scan again'}
                </button>
              </div>
              {networks.length > 0 ? (
                <select value={ssid} onChange={(e) => setSsid(e.target.value)} className={input}>
                  <option value="">Choose a network…</option>
                  {networks.map((n) => (
                    <option key={`${n.ssid}-${n.rssi}`} value={n.ssid}>
                      {n.ssid} {n.security === 'none' ? '(open)' : ''} · {n.rssi} dBm
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={ssid}
                  onChange={(e) => setSsid(e.target.value)}
                  placeholder="Network name"
                  required
                  className={input}
                />
              )}
              {networks.length > 0 && (
                <input
                  value={ssid}
                  onChange={(e) => setSsid(e.target.value)}
                  placeholder="…or type a hidden network's name"
                  className={`${input} mt-2`}
                />
              )}
            </div>

            <label className="block">
              <span className={label}>Password</span>
              <input
                value={psk}
                onChange={(e) => setPsk(e.target.value)}
                type="password"
                placeholder="Leave blank for an open network"
                className={input}
              />
            </label>

            <p className="text-xs text-gray-500">
              The display will join this network, ask <span className="font-mono">{baseUrl}</span>{' '}
              what to run, and install it. Anything you leave blank keeps what the display already
              has.
            </p>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={factoryReset}
                disabled={busy}
                className="text-xs text-red-500 hover:underline"
              >
                Factory reset instead
              </button>
              <button
                type="submit"
                disabled={busy || !ssid.trim()}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
              >
                Set up display
              </button>
            </div>
          </form>
        )}

        {step === 'working' && (
          <div className="space-y-3">
            <p className="text-sm text-gray-300">
              {rebooted
                ? 'The display has restarted itself'
                : status
                  ? describeState(status)
                  : 'Writing…'}
            </p>
            {committed && (
              /* The commit is the commitment: everything written is on the
                 device from here, whether or not it gets any further. */
              <p className="text-xs text-gray-500">
                Settings saved to the display. Waiting for it to join {ssid} and reach the server.
              </p>
            )}
            {rebooted && (
              /* Said out loud because it looks like a failure and is not: the
                 device installs, seals, and restarts, which is what takes the
                 Bluetooth link away. */
              <p className="text-xs text-gray-500">
                Restarting is part of setting one up — it installs, locks its filesystem, and reboots.
                Bluetooth drops when it does, so the rest of this is the server hearing from it.
              </p>
            )}
            {waitingTooLong && (
              <Notice tone="amber">
                Still nothing after three minutes. It is safe to close this — the display keeps
                trying on its own, and the Devices list shows its last check-in. If it never
                appears, the usual causes are a wrong Wi-Fi password or a network that cannot
                reach the internet.
              </Notice>
            )}
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-3">
            <Notice tone="green">
              {device.name} has joined {ssid} and asked the server what to run.
            </Notice>
            {/* Two different claims, and only the first is proven here. What it
                ends up running arrives on a later check-in, after it has
                installed and restarted. */}
            <p className="text-xs text-gray-500">
              {live?.installedPackages
                ? `Running ${live.installedPackages.split(',').join(', ')}.`
                : 'It is installing now and will restart itself when it is done. The Devices list shows what it ends up running.'}
            </p>
            <button onClick={onClose} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm">
              Done
            </button>
          </div>
        )}

        {error && <Notice tone="red">{error}</Notice>}

        {error && step === 'working' && (
          <button
            onClick={() => { setError(null); setStep('network'); }}
            className="text-xs text-brand-400 hover:underline"
          >
            Back to the network settings
          </button>
        )}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'red' | 'amber' | 'green'; children: React.ReactNode }) {
  const tones = {
    red: 'bg-red-950/40 border-red-900 text-red-300',
    amber: 'bg-amber-950/40 border-amber-900 text-amber-200',
    green: 'bg-green-900/30 border-green-700 text-green-300',
  };
  return <div className={`border rounded px-3 py-2 text-xs ${tones[tone]}`}>{children}</div>;
}
