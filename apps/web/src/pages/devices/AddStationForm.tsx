import { useState } from 'react';
import { api } from '../../lib/api';
import type { DeviceItem, ProvisionedDevice } from '../../lib/api.types';

const ATTENDANT_ROLE = 'ski_swap.staff_check_in' as const;

export type StationKind = 'self_service' | 'staffed';

/** What the caller still has to show once the writes are done. */
export type AddStationResult = {
  stationId: string;
  /** Provisioned here; its secret is shown once and has not been shown yet. */
  newTablet: ProvisionedDevice | null;
};

const inputClass =
  'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm';

/**
 * Adding one station of one kind.
 *
 * The two kinds are separate tables with separate buttons, so this form never
 * asks which — it is told, and asks only for what that kind needs. A staffed
 * station always provisions its own iPad: the station and the tablet are one
 * thing being set up, and a tablet bound to nothing cannot check anyone in.
 *
 * A bridge is only ever chosen here, never created. Setting one up means
 * holding the board and sending it Wi-Fi over Bluetooth, which is the Printers
 * page's job — offering it here produced a bridge that was bound, looked
 * configured, and had never been switched on.
 */
export default function AddStationForm({
  orgId,
  kind,
  bridges,
  onCancel,
  onDone,
}: {
  orgId: string;
  kind: StationKind;
  /**
   * The bridges this kind of station may choose: only free ones for a
   * self-service station, and for a staffed one also those already serving
   * staffed stations (Plan 27).
   */
  bridges: (DeviceItem & { alsoServes?: string[] })[];
  onCancel: () => void;
  onDone: (result: AddStationResult) => void;
}) {
  const staffed = kind === 'staffed';
  const [name, setName] = useState('');
  const [bridgeChoice, setBridgeChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // A self-service station without a bridge is one a seller cannot use. The
  // server has no opinion — the kind is derived from the hardware — so the
  // requirement lives here.
  const ready = !!name.trim() && (staffed || !!bridgeChoice);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      // The station first, so everything after has something to bind to. A
      // failure part-way leaves real hardware in the list rather than nothing.
      const station = await api.skiSwap.createStation(orgId, name.trim());

      let newTablet: ProvisionedDevice | null = null;

      if (staffed) {
        newTablet = await api.devices.provision(orgId, {
          name: `${name.trim()} iPad`,
          role: ATTENDANT_ROLE,
        });
        await api.skiSwap.patchStation(orgId, station.id, { attendantDeviceId: newTablet.id });
      }

      if (bridgeChoice) {
        await api.skiSwap.patchStation(orgId, station.id, { bridgeDeviceId: bridgeChoice });
      }

      onDone({ stationId: station.id, newTablet });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set that station up');
      setBusy(false);
    }
  }

  return (
    <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
      <h3 className="text-white font-medium">
        New {staffed ? 'staff' : 'self'} check-in station
      </h3>

      <label className="block">
        <span className="block text-xs text-gray-400 mb-1">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Front counter"
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className="block text-xs text-gray-400 mb-1">
          {staffed ? 'Print bridge (optional)' : 'Print bridge'}
        </span>
        <select
          value={bridgeChoice}
          onChange={(e) => setBridgeChoice(e.target.value)}
          className={inputClass}
        >
          {staffed ? (
            <option value="">No bridge — the iPad prints over Bluetooth</option>
          ) : (
            <option value="">Choose a bridge…</option>
          )}
          {bridges.map((b) => (
            <option key={b.id} value={b.id}>
              {b.printerName ?? b.name}
              {b.alsoServes?.length ? ` — also serves ${b.alsoServes.join(', ')}` : ''}
            </option>
          ))}
        </select>
      </label>

      {/* Self-service cannot go without one, so an empty list is a dead end
          rather than a choice — say where bridges come from. */}
      {!staffed && bridges.length === 0 && (
        <p className="text-xs text-amber-400">
          No print bridge is free. Set one up on the Printers page first — it needs its Wi-Fi
          and its printer over Bluetooth, with the board to hand.
        </p>
      )}

      {staffed && (
        <p className="text-xs text-gray-500">
          A provisioning code is shown once this is created. Scan it with the iPad that will
          live at this counter.
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-3 py-2">
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!ready || busy}
          className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
        >
          {busy ? 'Setting up…' : 'Add station'}
        </button>
      </div>
    </div>
  );
}
