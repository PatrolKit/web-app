import { useState } from 'react';
import { api } from '../../lib/api';
import type { DeviceItem, StationTabletOption } from '../../lib/api.types';

export type StationKind = 'self_service' | 'staffed';

const inputClass =
  'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm';

/**
 * Adding one station of one kind.
 *
 * The two kinds are separate tables with separate buttons, so this form never
 * asks which — it is told, and asks only for what that kind needs. A staffed
 * station takes one of the org's tablets, which org administrators add on
 * Tablets (Plan 56). It can be chosen later: the station stays staffed,
 * waiting for one.
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
  tablets = [],
  onCancel,
  onDone,
}: {
  orgId: string;
  kind: StationKind;
  /** Tablets serving no station: the ones a new staffed station may take. */
  tablets?: StationTabletOption[];
  /**
   * The bridges this kind of station may choose: only free ones for a
   * self-service station, and for a staffed one also those already serving
   * staffed stations (Plan 27).
   */
  bridges: (DeviceItem & { alsoServes?: string[] })[];
  onCancel: () => void;
  onDone: () => void;
}) {
  const staffed = kind === 'staffed';
  const [name, setName] = useState('');
  const [tabletChoice, setTabletChoice] = useState('');
  const [bridgeChoice, setBridgeChoice] = useState('');
  const sharedWith = bridges.find((b) => b.id === bridgeChoice)?.alsoServes ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // A self-service station without a bridge is one a seller cannot use. The
  // server lets one wait for its bridge, so the requirement lives here.
  const ready = !!name.trim() && (staffed || !!bridgeChoice);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      // The station first, so everything after has something to bind to. A
      // failure part-way leaves real hardware in the list rather than nothing.
      const station = await api.skiSwap.createStation(orgId, name.trim(), kind);

      if (staffed && tabletChoice) {
        await api.skiSwap.patchStation(orgId, station.id, { attendantDeviceId: tabletChoice });
      }

      if (bridgeChoice) {
        await api.skiSwap.patchStation(orgId, station.id, { bridgeDeviceId: bridgeChoice });
      }

      onDone();
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

      {staffed && (
        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">Tablet</span>
          <select value={tabletChoice} onChange={(e) => setTabletChoice(e.target.value)} className={inputClass}>
            <option value="">None yet — choose one later</option>
            {tablets.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          {tablets.length === 0 && (
            <span className="block text-xs text-gray-500 mt-1">
              No tablet is free. An org administrator adds tablets on the Tablets page.
            </span>
          )}
        </label>
      )}

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
            <option key={b.id} value={b.id}>{b.printerName ?? b.name}</option>
          ))}
        </select>
        {/* Said below the picker rather than in it, as on the station rows. */}
        {sharedWith.length > 0 && (
          <span className="block text-xs text-gray-500 mt-1">Shared with {sharedWith.join(', ')}</span>
        )}
      </label>

      {/* Self-service cannot go without one, so an empty list is a dead end
          rather than a choice — say where bridges come from. */}
      {!staffed && bridges.length === 0 && (
        <p className="text-xs text-amber-400">
          No print bridge is free. Set one up on the Printers page first — it needs its Wi-Fi
          and its printer over Bluetooth, with the board to hand.
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
