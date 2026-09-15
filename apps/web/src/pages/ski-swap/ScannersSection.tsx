import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { isWebBluetoothSupported } from '../../lib/printing/PhomemoPrinterService';
import {
  scanForScanner,
  SCANNER_FACTORY_NAME_PREFIX,
} from '../../lib/printing/InateckScannerService';
import type { SwapScanner } from '../../lib/api.types';

/**
 * The barcode scanners this org owns.
 *
 * The same shape as the printer list above it, and provisioned the same way:
 * pick the peripheral out of the BLE picker to capture the name it advertises,
 * give it a name a person would use, and bind it to a bridge.
 *
 * Renaming the hardware to something of ours was tried and does not work — see
 * the banner in InateckScannerService. So the advertised name is what is stored,
 * and two scanners are distinguishable only if the hardware makes them so.
 *
 * The browser never talks to a scanner. Picking one here only reads its name;
 * the bridge is what holds the link.
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
  const [error, setError] = useState('');

  const scannersKey = ['ski-swap/scanners', orgId];
  const { data: scanners = [] } = useQuery({
    queryKey: scannersKey,
    queryFn: () => api.skiSwap.listScanners(orgId),
    enabled: !!orgId,
  });

  const createMutation = useMutation({
    mutationFn: () => api.skiSwap.createScanner(orgId, { name, bluetoothName: airName }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scannersKey });
      closeForm();
    },
    onError: (e: Error) => setError(e instanceof ApiError ? e.message : 'Could not add that scanner'),
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

  const busy = createMutation.isPending;

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
          onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
        >
          <h3 className="text-white font-medium">New scanner</h3>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Bluetooth device</span>
            <div className="mt-1 flex gap-2">
              <input
                readOnly
                value={airName}
                placeholder="Pick the scanner to read its name"
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
                Saying what counts as a scanner is what makes an empty list readable. */}
            <p className="mt-1 text-gray-500 text-xs">
              Wake the scanner first — it has to be advertising to appear. The list holds
              scanners only, which call themselves{' '}
              <span className="font-mono text-gray-400">{SCANNER_FACTORY_NAME_PREFIX}…</span>;
              an empty list means nothing is awake and in range, not that nothing is there.
              The name is stored exactly as it comes off the air, because that is what the
              bridge connects to.
            </p>
            <p className="mt-1 text-gray-500 text-xs">
              If two scanners advertise the same name, only the first can be added — there
              is nothing else to tell them apart by. Add them one at a time so you know
              which one you are holding.
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
              {busy ? 'Adding…' : 'Add scanner'}
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
                <p className="text-sm text-white">{s.name}</p>
                {/* Back on the row rather than a tooltip: now that this is the
                    name the hardware chose, it is how somebody matches a scanner
                    in their hand to a line on this screen. */}
                <p className="text-xs text-gray-500 font-mono">{s.bluetoothName}</p>
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
