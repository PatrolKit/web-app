import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faTriangleExclamation as faTriangleExclamationDuo } from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';
import {
  BridgeProvisioningPanel,
  MutationError,
  SECRET_LOSS_WARNING,
  useServerConfirmation,
} from '../devices/DeviceCredentials';
import { deviceLabel } from '../../lib/api.types';
import type { DeviceItem, SwapPrinterRecord } from '../../lib/api.types';

/**
 * Everything about one bridge, split by where the setting actually lives.
 *
 * The split is not cosmetic. The printer binding is a row in our database and
 * changes instantly. Wi-Fi credentials and the client secret live in the
 * board's own flash, and the firmware latches provisioning shut the
 * moment the server accepts its credentials — permanently, refusing every
 * further write. So on any bridge that has ever worked, changing either one
 * means holding BOOT for five seconds, which erases all of it: Wi-Fi, printer,
 * and secret alike. They are not separate operations on real hardware, and a
 * screen that offered them separately would be describing a device we do not
 * ship.
 */
export default function BridgeEditModal({
  orgId,
  bridge: initialBridge,
  printers,
  boundPrinter,
  initialSecret,
  onClose,
}: {
  orgId: string;
  bridge: DeviceItem;
  printers: SwapPrinterRecord[];
  boundPrinter: SwapPrinterRecord | undefined;
  /**
   * A secret minted moments ago, when this screen opened straight off
   * provisioning. The board has to be written before it is any use, and this is
   * the only copy — so the screen opens ready to write it and refuses to be
   * closed quietly until the server has heard back.
   */
  initialSecret?: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [printerId, setPrinterId] = useState(boundPrinter?.id ?? '');
  const [secret, setSecret] = useState<string | null>(initialSecret ?? null);

  // A brand-new bridge has never been seen, so any last-seen at all confirms it.
  const [since] = useState(initialSecret ? null : initialBridge.lastSeenAt);
  const { device, confirmed } = useServerConfirmation(orgId, initialBridge.id, since);
  // Prefer the polled copy: binding a printer renames the bridge, and the
  // heading should follow rather than hold the name it opened with.
  const bridge = device ?? initialBridge;

  // Whether the board is still pointed at the printer the server thinks it
  // drives. The board connects by Bluetooth name, written once at setup and
  // never refetched, so rebinding here alone leaves the two disagreeing:
  // the server renders for the new printer's paper and margins, and the label
  // comes out of the old one.
  const printerChanged = (boundPrinter?.id ?? '') !== printerId;

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
      // The bridge is named after its printer, so rebinding renames it too.
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
    },
  });

  // Re-provisioning needs a secret, and the old one is unrecoverable by design —
  // so a new one is minted at the moment it is about to be written to a board.
  const rotateMutation = useMutation({
    mutationFn: () => api.devices.rotateSecret(orgId, bridge.id),
    onSuccess: (d) => setSecret(d.clientSecret),
  });

  const freshlyProvisioned = !!initialSecret;
  const savingBusy = bindMutation.isPending;
  /** An outstanding secret is one the server has not yet seen used. */
  const unwrittenSecret = !!secret && !confirmed;

  function close() {
    if (unwrittenSecret && !window.confirm(SECRET_LOSS_WARNING)) return;
    onClose();
  }

  async function save() {
    if (printerChanged) await bindMutation.mutateAsync();
    close();
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-surface-200 rounded-lg p-6 w-full max-w-lg space-y-5 my-8">
        <div>
          <h2 className="text-white font-semibold">{deviceLabel(bridge)}</h2>
          <p className="text-xs text-gray-500 font-mono mt-0.5">{bridge.clientId}</p>
        </div>

        {/* ── Stored here ─────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Drives printer</span>
            <select
              value={printerId}
              onChange={(e) => setPrinterId(e.target.value)}
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            >
              <option value="">Not connected</option>
              {printers
                .filter((p) => p.id === boundPrinter?.id || (!p.bridgeDeviceId && !p.assignedSellerId))
                .map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.bluetoothName})</option>
                ))}
            </select>
          </label>

          {printerChanged && (
            <p className="text-xs text-amber-400 flex gap-2">
              <FontAwesomeIcon icon={faTriangleExclamationDuo} className="mt-0.5 shrink-0" />
              <span>
                This changes which printer the server renders for, but not which one the
                board talks to — that Bluetooth name was written into the board at setup
                and it never asks the server for a new one. Until you set the bridge up
                again below, labels will be laid out for{' '}
                <span className="text-gray-300">
                  {printers.find((p) => p.id === printerId)?.name ?? 'nothing'}
                </span>{' '}
                and come out of{' '}
                <span className="text-gray-300">{boundPrinter?.name ?? 'the old printer'}</span>.
              </span>
            </p>
          )}

          <p className="text-xs text-gray-500">
            A bridge is called after the printer it drives, so this is also what it is
            named. It has no name of its own.
          </p>

          <MutationError error={bindMutation.error} />
        </div>

        {/* ── Stored on the board ─────────────────────────────────────────── */}
        <div className="border-t border-gray-700 pt-4 space-y-2">
          <h3 className="text-white text-sm font-medium">Wi-Fi and credentials</h3>

          {freshlyProvisioned ? (
            // A board straight out of the box is unlocked, so none of the
            // factory-reset ceremony below applies yet.
            <p className="text-xs text-gray-400">
              This bridge has credentials but nothing else. Write its Wi-Fi, its printer and
              those credentials to the board over Bluetooth to finish setting it up.
            </p>
          ) : (
            <>
              <p className="text-xs text-gray-400">
                Both live in the board&apos;s flash, and the firmware latches shut for good once
                the server accepts its credentials. Changing the Wi-Fi password, moving the
                bridge to a different printer, or issuing a fresh client secret all mean the
                same physical job:
              </p>
              <ol className="text-xs text-gray-400 list-decimal ml-4 space-y-0.5">
                <li>Hold the board&apos;s BOOT button for 5 seconds. It erases everything and reboots into setup.</li>
                <li>Set it up again below — new Wi-Fi, printer and secret are written together.</li>
              </ol>
            </>
          )}

          {secret ? (
            <BridgeProvisioningPanel
              clientId={bridge.clientId}
              secret={secret}
              printers={printers}
              confirmed={confirmed}
            />
          ) : (
            <>
              <p className="text-xs text-amber-400 flex gap-2 pt-1">
                <FontAwesomeIcon icon={faTriangleExclamationDuo} className="mt-0.5 shrink-0" />
                <span>
                  Starting this issues a new client secret, which retires the old one
                  immediately. A bridge that is printing now will stop until you finish
                  writing the new one to the board.
                </span>
              </p>
              <MutationError error={rotateMutation.error} />
              <button
                onClick={() => {
                  if (window.confirm(
                    `Set up "${deviceLabel(bridge)}" again?\n\n` +
                      'This issues a new client secret and retires the current one straight ' +
                      'away. If this bridge is working, it stops printing until the new ' +
                      'secret is written to the board over Bluetooth — which needs the board ' +
                      'factory-reset with the BOOT button first.\n\nContinue?',
                  )) rotateMutation.mutate();
                }}
                disabled={rotateMutation.isPending}
                className="text-sm bg-surface-100 hover:bg-surface-50 text-gray-200 border border-gray-600 rounded px-3 py-1.5 disabled:opacity-40"
              >
                {rotateMutation.isPending ? 'Issuing…' : 'Set up this bridge again'}
              </button>
            </>
          )}
        </div>

        <div className="flex gap-2 pt-1">
          <button
            onClick={save}
            disabled={savingBusy || !printerChanged}
            className="flex-1 bg-brand-600 hover:bg-brand-700 text-white text-sm rounded py-1.5 disabled:opacity-40"
          >
            {savingBusy ? 'Saving…' : 'Save'}
          </button>
          <button onClick={close} className="flex-1 bg-surface-100 text-gray-300 text-sm rounded py-1.5">
            {printerChanged ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  );
}
