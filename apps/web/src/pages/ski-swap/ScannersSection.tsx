import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { isWebBluetoothSupported } from '../../lib/printing/PhomemoPrinterService';
import {
  mintScannerName,
  renameScanner,
  scanForScanner,
  SCANNER_FACTORY_NAME_PREFIX,
  SCANNER_NAME_PREFIX,
} from '../../lib/printing/InateckScannerService';
import type { SwapScanner } from '../../lib/api.types';

/**
 * The barcode scanners this org owns.
 *
 * The same shape as the printer list above it, with one difference that matters:
 * provisioning a scanner *writes* to it. A printer is recorded under whatever
 * name it already advertises; a scanner is given one of ours, because the
 * advertised name is the only handle the bridge has — it re-scans for its target
 * by name on every reconnect — and the name a scanner ships with is `HPRT` on
 * every unit in the box.
 *
 * That name is minted, not typed. Nobody sees it if things are working; the
 * name below it on screen is the one a person chose.
 */
export default function ScannersSection({
  orgId,
  canAdmin,
}: {
  orgId: string;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [device, setDevice] = useState<BluetoothDevice | null>(null);
  const [airName, setAirName] = useState('');
  const [step, setStep] = useState<'idle' | 'renaming' | 'saving'>('idle');
  const [error, setError] = useState('');

  const scannersKey = ['ski-swap/scanners', orgId];
  const { data: scanners = [] } = useQuery({
    queryKey: scannersKey,
    queryFn: () => api.skiSwap.listScanners(orgId),
    enabled: !!orgId,
  });

  /**
   * Rename the hardware, then record it.
   *
   * This order, and not the reverse. If the rename lands and the save does not,
   * the scanner carries a name nothing knows about — which is harmless, because
   * nothing can be looking for it and the next attempt mints a fresh one. Saving
   * first would instead leave a row claiming a name the hardware never took, and
   * a bridge would hunt for it forever.
   *
   * Either failure clears the picked device on purpose. A scanner that has been
   * renamed is no longer the device the operator chose, so the honest next step
   * is to pick it again and provision it from the top.
   */
  const provisionMutation = useMutation({
    mutationFn: async () => {
      if (!device) throw new Error('Pick the scanner first.');
      const bluetoothName = mintScannerName();

      setStep('renaming');
      try {
        await renameScanner(device, bluetoothName);
      } catch (e) {
        throw new Error(
          `Could not rename the scanner: ${(e as Error)?.message ?? 'the connection failed'}. ` +
          'Nothing was saved. Wake it, keep it close to this computer, and pick it again.',
        );
      }

      setStep('saving');
      try {
        return await api.skiSwap.createScanner(orgId, { name, bluetoothName });
      } catch (e) {
        const why = e instanceof ApiError ? e.message : 'the server could not be reached';
        throw new Error(
          `The scanner was renamed, but not saved: ${why}. ` +
          'Pick it again to provision it from the top — it will be given a fresh name.',
        );
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scannersKey });
      closeForm();
    },
    onError: (e: Error) => {
      setStep('idle');
      setDevice(null);
      setAirName('');
      setError(e.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.skiSwap.deleteScanner(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: scannersKey }),
  });

  function closeForm() {
    setShowForm(false);
    setName('');
    setDevice(null);
    setAirName('');
    setStep('idle');
    setError('');
  }

  async function pick() {
    if (!isWebBluetoothSupported()) {
      setError('Adding a scanner over Bluetooth needs Chrome or Edge.');
      return;
    }
    try {
      const picked = await scanForScanner();
      setDevice(picked.device);
      setAirName(picked.bluetoothName);
      setError('');
    } catch (err: unknown) {
      // Closing the picker without choosing is not a failure worth reporting.
      if ((err as { name?: string })?.name !== 'NotFoundError') {
        setError((err as Error)?.message ?? 'Bluetooth scan failed');
      }
    }
  }

  const busy = provisionMutation.isPending;

  return (
    <div className="space-y-3 border-t border-gray-800 pt-6">
      <div>
        <h2 className="text-white font-medium">Scanners</h2>
        <p className="text-xs text-gray-500">
          The barcode scanners this org owns. A scanner is reached through a bridge, the
          same way a printer is — bind it to one below, on the bridge.
        </p>
      </div>

      {canAdmin && !showForm && (
        <div className="flex justify-end">
          <button
            onClick={() => { setShowForm(true); setError(''); }}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
          >
            + Add Scanner
          </button>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); provisionMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
        >
          <h3 className="text-white font-medium">New scanner</h3>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Bluetooth device</span>
            <div className="mt-1 flex gap-2">
              <input
                readOnly
                value={airName}
                placeholder="Pick the scanner to provision"
                className="flex-1 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
              />
              <button
                type="button"
                onClick={pick}
                disabled={busy}
                className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-3 py-2 rounded text-sm whitespace-nowrap"
              >
                Scan…
              </button>
            </div>
            {/* The picker matches on the name, because the BCST-23 advertises
                none of its services and there is nothing else to match on.
                Saying which names count is what makes an empty list readable. */}
            <p className="mt-1 text-gray-500 text-xs">
              Wake the scanner first — it has to be advertising to appear. The list holds
              scanners only: a new one calls itself{' '}
              <span className="font-mono text-gray-400">{SCANNER_FACTORY_NAME_PREFIX}…</span>,
              and one already set up here calls itself{' '}
              <span className="font-mono text-gray-400">{SCANNER_NAME_PREFIX}…</span>. An
              empty list means nothing is awake and in range, not that nothing is there.
            </p>
            <p className="mt-1 text-gray-500 text-xs">
              Adding a scanner renames it, so keep it awake and close to this computer until
              that finishes.
            </p>
          </label>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "Front counter scanner"'
              disabled={busy}
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white disabled:opacity-60"
            />
            <p className="mt-1 text-gray-500 text-xs">
              What people here call it. Name it for where it lives, not what it is — every
              one of these is a scanner.
            </p>
          </label>

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!name || !device || busy}
              className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
            >
              {step === 'renaming' ? 'Renaming the scanner…'
                : step === 'saving' ? 'Saving…'
                : 'Add scanner'}
            </button>
            <button
              type="button"
              onClick={closeForm}
              disabled={busy}
              className="text-gray-400 hover:text-white disabled:opacity-40 text-sm px-3 py-2"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {scanners.length === 0 ? (
        <p className="text-gray-400 text-sm">No scanners yet.</p>
      ) : (
        <ul className="space-y-2">
          {scanners.map((s: SwapScanner) => (
            <li
              key={s.id}
              className="bg-surface-50 border border-gray-700 rounded-lg p-3 flex items-start justify-between gap-3"
            >
              <div>
                {/* The minted name is on the tooltip rather than the row: it is
                    what a bridge log prints, so it has to be reachable, but it
                    means nothing to the person reading this list. */}
                <p className="text-sm text-white" title={s.bluetoothName}>{s.name}</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {s.bridgeDeviceId
                    ? s.stationName
                      ? `On a bridge at ${s.stationName}`
                      : 'On a bridge that serves no station yet'
                    : 'Not bound to a bridge'}
                </p>
              </div>
              {canAdmin && (
                <button
                  onClick={() => {
                    if (confirm(`Remove "${s.name}"? The bridge stops using it at once.`)) {
                      deleteMutation.mutate(s.id);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="text-xs text-red-500 hover:underline disabled:opacity-40"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
