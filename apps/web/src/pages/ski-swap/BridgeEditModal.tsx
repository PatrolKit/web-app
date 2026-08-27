import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import {
  BridgeLockedError,
  currentBaseUrl,
  isProvisionableOrigin,
  isWebBluetoothSupported,
  provisionBridge,
  type BridgeStatus,
} from '../../lib/printing/BridgeProvisioningService';
import { MutationError, useServerConfirmation } from '../devices/DeviceCredentials';
import type { DeviceItem, SwapPrinterRecord } from '../../lib/api.types';

/**
 * Sets a bridge up: which printer it drives, which Wi-Fi it joins, and its own
 * server credentials — written to the board in one go, because the firmware
 * accepts them no other way.
 *
 * There is no save-then-apply here. All three live in the board's flash, and
 * provisioning latches shut for good once the server accepts the credentials,
 * so every change is the same physical job: reset the board, write all three.
 * Sending mints a fresh secret as part of that, which is why the board has to
 * be reset first — the old one stops working either way.
 *
 * The printer binding is recorded only once the board has taken the config. A
 * bridge connects to a Phomemo by Bluetooth name and never asks the server for
 * a new one, so a binding stored ahead of the write is a claim that is not true
 * yet: the server would render for one printer while the board printed on
 * another.
 */
export default function BridgeEditModal({
  orgId,
  bridge: initialBridge,
  printers,
  boundPrinter,
  justProvisioned,
  onClose,
}: {
  orgId: string;
  bridge: DeviceItem;
  printers: SwapPrinterRecord[];
  boundPrinter: SwapPrinterRecord | undefined;
  /** Opened straight off provisioning, so the board has never latched. */
  justProvisioned?: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [printerId, setPrinterId] = useState(boundPrinter?.id ?? '');
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
  const printer = printers.find((p) => p.id === printerId) ?? null;

  // A bridge that is going to reach the server does so within a couple of
  // seconds of joining Wi-Fi. Waiting longer and still hearing nothing is the
  // failure, not a slow start.
  useEffect(() => {
    if (!boardOnline || confirmed) return;
    const t = setTimeout(() => setServerOverdue(true), 20_000);
    return () => clearTimeout(t);
  }, [boardOnline, confirmed]);

  const bindMutation = useMutation({
    mutationFn: async () => {
      // The foreign key is on the printer, so a move is a release then a bind.
      if (boundPrinter && boundPrinter.id !== printerId) {
        await api.skiSwap.patchPrinter(orgId, boundPrinter.id, { bridgeDeviceId: null });
      }
      if (printerId) await api.skiSwap.patchPrinter(orgId, printerId, { bridgeDeviceId: bridge.id });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] });
      // The bridge is named after its printer, so binding renames it too.
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
    },
  });

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
          printerBluetoothName: printer!.bluetoothName,
          baseUrl,
          clientId: bridge.clientId,
          clientSecret,
        },
        setStatus,
        { onCommitted: () => bindMutation.mutate() },
      );
      setStatus(final);
      setBoardOnline(true);
    } catch (err) {
      // A cancelled picker is a decision, not a failure.
      if ((err as { name?: string })?.name === 'NotFoundError') return;
      setError(
        err instanceof BridgeLockedError
          ? 'This board is still locked. Hold RESET for 5 seconds to clear it, then send again.'
          : err instanceof Error
            ? err.message
            : 'Sending failed',
      );
    } finally {
      setBusy(false);
    }
  }

  const canSend = supported && httpsOk && !!printer && !!ssid.trim() && !busy && !boardOnline;

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
            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">Printer this bridge drives</span>
              <select
                value={printerId}
                onChange={(e) => setPrinterId(e.target.value)}
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              >
                <option value="" disabled>Pick a printer</option>
                {printers
                  .filter((p) => p.id === boundPrinter?.id || (!p.bridgeDeviceId && !p.assignedSellerId))
                  .map((p) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.bluetoothName})</option>
                  ))}
              </select>
            </label>

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
            <MutationError error={bindMutation.error} />

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
