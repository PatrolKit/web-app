import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { DeviceItem, SwapPrinterRecord, SwapScanner } from '../../lib/api.types';
import { useState } from 'react';

/**
 * What one bridge drives: a printer, a scanner, either, neither.
 *
 * Both live here, on the bridge, because the bridge is the thing that holds the
 * two links — asking on the printer row which bridge drives it made the answer
 * depend on which page you happened to be reading.
 *
 * Saved the moment it is picked, with no Bluetooth anywhere near it. The board
 * learns its peripherals from the claim and retargets its radios on the next
 * poll, so a reassignment is a row in a table, not a visit to the hardware. That
 * is why this is not in `BridgeEditModal`: that modal exists to reset a board and
 * write its flash, and nothing here needs either.
 */
export default function BridgePeripherals({
  orgId,
  bridge,
  printers,
  scanners,
  canAdmin,
}: {
  orgId: string;
  bridge: DeviceItem;
  printers: SwapPrinterRecord[];
  scanners: SwapScanner[];
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const boundPrinter = printers.find((p) => p.bridgeDeviceId === bridge.id) ?? null;
  const boundScanner = scanners.find((s) => s.bridgeDeviceId === bridge.id) ?? null;

  function invalidate() {
    void qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] });
    void qc.invalidateQueries({ queryKey: ['ski-swap/scanners', orgId] });
    // A bridge's own row is named after what it drives.
    void qc.invalidateQueries({ queryKey: ['devices', orgId] });
  }

  /**
   * The foreign key is on the peripheral, so moving one is a release and a bind.
   *
   * Release first, always. Binding first would have two rows naming this bridge
   * for as long as the second call takes, which the unique index refuses — so the
   * move would fail rather than merely look untidy.
   */
  const assign = useMutation({
    mutationFn: async ({ kind, id }: { kind: 'printer' | 'scanner'; id: string }) => {
      const current = kind === 'printer' ? boundPrinter : boundScanner;
      const patch = kind === 'printer' ? api.skiSwap.patchPrinter : api.skiSwap.patchScanner;

      if (current && current.id !== id) await patch(orgId, current.id, { bridgeDeviceId: null });
      if (id) await patch(orgId, id, { bridgeDeviceId: bridge.id });
    },
    onSuccess: () => { invalidate(); setError(''); },
    // The server names whatever is in the way, which beats anything written here.
    onError: (e: Error) => {
      invalidate(); // a half-done move must not leave the selects lying
      setError(e instanceof ApiError ? e.message : 'Could not change what this bridge drives');
    },
  });

  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Picker
          label="Printer"
          value={boundPrinter?.id ?? ''}
          disabled={!canAdmin || assign.isPending}
          onChange={(id) => assign.mutate({ kind: 'printer', id })}
          options={printers
            // A printer handed to a business seller is theirs and prints over
            // Bluetooth from their own machine; it never belongs to a bridge.
            .filter((p) => p.id === boundPrinter?.id || (!p.bridgeDeviceId && !p.assignedSellerId))
            .map((p) => ({ id: p.id, label: `${p.name} (${p.bluetoothName})` }))}
        />
        <Picker
          label="Scanner"
          value={boundScanner?.id ?? ''}
          disabled={!canAdmin || assign.isPending}
          onChange={(id) => assign.mutate({ kind: 'scanner', id })}
          options={scanners
            .filter((s) => s.id === boundScanner?.id || !s.bridgeDeviceId)
            .map((s) => ({ id: s.id, label: `${s.name} (${s.bluetoothName})` }))}
        />
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

function Picker({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-xs text-gray-400">{label}</span>
      <select
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white disabled:opacity-50 max-w-[15rem]"
      >
        <option value="">— none —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}
