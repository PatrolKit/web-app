import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import {
  BridgeLockedError,
  currentBaseUrl,
  isProvisionableOrigin,
  isWebBluetoothSupported,
  provisionBridge,
  type BridgeStatus,
} from '../../lib/printing/BridgeProvisioningService';
import { useServerConfirmation } from '../devices/DeviceCredentials';
import type { DeviceItem } from '../../lib/api.types';

/**
 * Gets a bridge onto the network: the Wi-Fi it joins and its own server
 * credentials, written to the board together because the firmware accepts them
 * no other way.
 *
 * There is no save-then-apply here. Both live in the board's flash, and
 * provisioning latches shut for good once the server accepts the credentials, so
 * every change is the same physical job: reset the board, write both. Sending
 * mints a fresh secret as part of that, which is why the board has to be reset
 * first — the old one stops working either way.
 *
 * **Which peripherals a bridge drives is no longer set here.** It used to be,
 * because a bridge connected to a Phomemo by Bluetooth name and never asked the
 * server for a new one, so the binding could not be recorded until the board had
 * taken the config. The firmware now reads its assignments from the claim, so
 * they are picked on the bridge's row and reach the board on its next poll —
 * which means reassigning a printer no longer costs a board reset.
 */
export default function BridgeEditModal({
  orgId,
  bridge: initialBridge,
  justProvisioned,
  onClose,
}: {
  orgId: string;
  bridge: DeviceItem;
  /** Opened straight off provisioning, so the board has never latched. */
  justProvisioned?: boolean;
  onClose: () => void;
}) {
  const [ssid, setSsid] = useState('');
  const [psk, setPsk] = useState('');

  const [askingToSend, setAskingToSend] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boardOnline, setBoardOnline] = useState(false);
  const [serverOverdue, setServerOverdue] = useState(false);

  const [since] = useState(justProvisioned ? null : initialBridge.lastSeenAt);
  const { device, confirmed } = useServerConfirmation(orgId, initialBridge.id, since);
  const bridge = device ?? initialBridge;

  const baseUrl = currentBaseUrl();
  const httpsOk = isProvisionableOrigin(baseUrl);
  const supported = isWebBluetoothSupported();

  // A bridge that is going to reach the server does so within a couple of
  // seconds of joining Wi-Fi. Waiting longer and still hearing nothing is the
  // failure, not a slow start.
  useEffect(() => {
    if (!boardOnline || confirmed) return;
    const t = setTimeout(() => setServerOverdue(true), 20_000);
    return () => clearTimeout(t);
  }, [boardOnline, confirmed]);

  async function send() {
    setAskingToSend(false);
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // Minted here rather than held: the board is about to be written, and a
      // secret issued any earlier is one more thing left stranded if this never
      // happens.
      const { clientSecret } = await api.devices.rotateSecret(orgId, bridge.id);
      const final = await provisionBridge(
        {
          ssid: ssid.trim(),
          psk,
          baseUrl,
          clientId: bridge.clientId,
          clientSecret,
        },
        setStatus,
      );
      setStatus(final);
      setBoardOnline(true);
    } catch (err) {
      // A cancelled picker is a decision, not a failure.
      if ((err as { name?: string })?.name === 'NotFoundError') return;
      setError(
        err instanceof BridgeLockedError
          ? 'This board is still locked. Hold RESET for 5 seconds to clear it, then send again.'
          // Everything else, CommitRejectedError included, carries its own words.
          : err instanceof Error
            ? err.message
            : 'Sending failed',
      );
    } finally {
      setBusy(false);
    }
  }

  const canSend = supported && httpsOk && !!ssid.trim() && !busy && !boardOnline;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-surface-200 rounded-lg p-6 w-full max-w-lg space-y-4 my-8">
        <div>
          <h2 className="text-white font-semibold">Set up this bridge over Bluetooth</h2>
          <p className="text-xs text-gray-500 font-mono mt-0.5">{bridge.clientId}</p>
        </div>

        <p className="text-xs text-gray-400">
          Be sure to press and hold the RESET button before making changes here.
        </p>

        {confirmed ? (
          <p className="text-green-400 text-sm border-t border-green-800 pt-4">
            Bridge online{status?.device ? ` — ${status.device}` : ''}, and the server has
            heard from it.
          </p>
        ) : boardOnline && serverOverdue ? (
          // The one failure a board reports as success: Wi-Fi joined, then
          // silence where the token exchange should be.
          <div className="border-t border-amber-800 pt-4 space-y-2">
            <p className="text-amber-400 text-sm font-medium">
              The board says it is online, but the server has never heard from it.
            </p>
            <p className="text-xs text-gray-400">
              Wi-Fi worked — the failure is after that, when the bridge exchanges its client
              secret for a token. Check the firmware build, and that the board&apos;s clock is
              set, since TLS rejects a certificate that looks expired from the board&apos;s
              point of view.
            </p>
            <button
              onClick={() => { setBoardOnline(false); setServerOverdue(false); setStatus(null); }}
              className="text-xs text-brand-500 hover:underline"
            >
              Try sending again
            </button>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
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

            {!supported && (
              <p className="text-amber-400 text-xs">Bluetooth setup needs Chrome or Edge.</p>
            )}
            {supported && !httpsOk && (
              <p className="text-amber-400 text-xs">
                The bridge only accepts an https server, and this page is on {baseUrl}. Set
                bridges up from the deployed site rather than a local dev server.
              </p>
            )}

            {boardOnline ? (
              <p className="text-xs text-gray-400">
                Wi-Fi joined. Waiting for the server to hear from the bridge…
              </p>
            ) : status ? (
              <p className="text-xs text-gray-400">{describeBridgeState(status)}</p>
            ) : null}
            {error && <p className="text-red-400 text-xs">{error}</p>}

            <button
              onClick={() => setAskingToSend(true)}
              disabled={!canSend}
              className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm rounded px-4 py-2"
            >
              {busy ? 'Sending…' : 'Send over Bluetooth'}
            </button>
          </>
        )}

        <button onClick={onClose} className="w-full bg-surface-100 text-gray-300 text-sm rounded py-1.5">
          {confirmed ? 'Close' : 'Cancel'}
        </button>
      </div>

      {askingToSend && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4">
          <div className="bg-surface-200 border border-gray-700 rounded-lg p-6 w-full max-w-sm space-y-4">
            <p className="text-white text-sm">Device must be on, RESET, and nearby.</p>
            <div className="flex gap-2">
              <button
                onClick={send}
                className="flex-1 bg-brand-600 hover:bg-brand-700 text-white text-sm rounded py-1.5"
              >
                Continue
              </button>
              <button
                onClick={() => setAskingToSend(false)}
                className="flex-1 bg-surface-100 text-gray-300 text-sm rounded py-1.5"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
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
