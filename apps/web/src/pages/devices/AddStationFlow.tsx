import { useState } from 'react';
import { api } from '../../lib/api';
import type { DeviceItem, ProvisionedDevice } from '../../lib/api.types';

const ATTENDANT_ROLE = 'ski_swap.staff_check_in' as const;
const BRIDGE_ROLE = 'ski_swap.print_bridge' as const;

export type StationKind = 'self_service' | 'staffed';

/** What the caller has to do once the station exists and the writes are done. */
export type AddStationResult = {
  stationId: string;
  /** Provisioned here, and still needing its credentials shown. */
  newTablet: ProvisionedDevice | null;
  /** Provisioned here, and still needing its Bluetooth setup. */
  newBridge: ProvisionedDevice | null;
};

const inputClass =
  'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm';
const selectClass =
  'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm';

/** Sentinel for "make me a new one", distinct from an id and from unset. */
const NEW = '__new__';

/**
 * Setting up a check-in station, kind first.
 *
 * The old flow asked for a name and produced a station with two empty device
 * slots, which is the shape of the row rather than the shape of the decision.
 * Nobody arrives wanting a station with an attendant slot filled; they arrive
 * building either a kiosk sellers use alone or a counter a volunteer works. The
 * kind is still derived from the hardware — no `kind` column, nothing new on the
 * server — but it is asked first, and each kind is then only asked for what it
 * actually needs.
 */
export default function AddStationFlow({
  orgId,
  tablets,
  bridges,
  onCancel,
  onDone,
}: {
  orgId: string;
  /** Unbound hardware only: anything already at a counter is not on offer. */
  tablets: DeviceItem[];
  bridges: DeviceItem[];
  onCancel: () => void;
  onDone: (result: AddStationResult) => void;
}) {
  const [kind, setKind] = useState<StationKind | null>(null);
  const [name, setName] = useState('');
  const [tabletChoice, setTabletChoice] = useState<string>(NEW);
  const [bridgeChoice, setBridgeChoice] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!kind) {
    return (
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
        <h3 className="text-white font-medium">What kind of station?</h3>
        <div className="grid md:grid-cols-2 gap-3">
          <KindCard
            title="Self-service"
            body="Sellers scan its QR code and check themselves in."
            need="Needs a print bridge — it is the only way a seller gets a tag."
            onClick={() => setKind('self_service')}
          />
          <KindCard
            title="Staffed"
            body="A volunteer works a tablet at the counter."
            need="A bridge is optional: the tablet prints over Bluetooth."
            onClick={() => setKind('staffed')}
          />
        </div>
        <div className="flex justify-end">
          <button onClick={onCancel} className="text-sm text-gray-400 hover:text-white px-3 py-2">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const staffed = kind === 'staffed';
  // Self-service without a bridge is a station a seller cannot use. The server
  // allows it — the kind is derived, and it has no opinion — so this is the
  // screen's job.
  const ready = !!name.trim() && (staffed || !!bridgeChoice);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      // Ordered so the station exists before anything is bound to it, and each
      // device exists before it is named as a slot. A failure part-way leaves
      // real hardware in the list rather than nothing — the same reasoning the
      // two-write bind has always had.
      const station = await api.skiSwap.createStation(orgId, name.trim());

      let newTablet: ProvisionedDevice | null = null;
      let newBridge: ProvisionedDevice | null = null;

      if (staffed) {
        const tabletId =
          tabletChoice === NEW
            ? (newTablet = await api.devices.provision(orgId, {
                name: `${name.trim()} tablet`,
                role: ATTENDANT_ROLE,
              })).id
            : tabletChoice;
        await api.skiSwap.patchStation(orgId, station.id, { attendantDeviceId: tabletId });
      }

      if (bridgeChoice) {
        const bridgeId =
          bridgeChoice === NEW
            ? (newBridge = await api.devices.provision(orgId, { role: BRIDGE_ROLE })).id
            : bridgeChoice;
        await api.skiSwap.patchStation(orgId, station.id, { bridgeDeviceId: bridgeId });
      }

      onDone({ stationId: station.id, newTablet, newBridge });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set that station up');
      setBusy(false);
    }
  }

  return (
    <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-white font-medium">
          New {staffed ? 'staffed' : 'self-service'} station
        </h3>
        <button
          onClick={() => setKind(null)}
          className="text-xs text-brand-500 hover:underline"
        >
          change
        </button>
      </div>

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
          <span className="block text-xs text-gray-400 mb-1">Staff tablet</span>
          <select
            value={tabletChoice}
            onChange={(e) => setTabletChoice(e.target.value)}
            className={selectClass}
          >
            <option value={NEW}>Set up a new tablet</option>
            {tablets.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
      )}

      <label className="block">
        <span className="block text-xs text-gray-400 mb-1">
          {staffed ? 'Print bridge (optional)' : 'Print bridge'}
        </span>
        <select
          value={bridgeChoice}
          onChange={(e) => setBridgeChoice(e.target.value)}
          className={selectClass}
        >
          {/* Only a staffed station may go without: it has a tablet that can
              print over Bluetooth. */}
          {staffed && <option value="">No bridge — the tablet prints over Bluetooth</option>}
          {!staffed && <option value="">Choose a bridge…</option>}
          <option value={NEW}>Set up a new bridge</option>
          {bridges.map((b) => (
            <option key={b.id} value={b.id}>{b.printerName ?? b.name}</option>
          ))}
        </select>
      </label>

      {bridgeChoice === NEW && (
        <p className="text-xs text-gray-500">
          Its Wi-Fi and printer are set next, over Bluetooth — you will need the board to hand.
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

function KindCard({
  title,
  body,
  need,
  onClick,
}: {
  title: string;
  body: string;
  need: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left bg-surface-100 border border-gray-700 hover:border-brand-600 rounded-lg p-4 space-y-1 transition-colors"
    >
      <p className="text-white font-medium">{title}</p>
      <p className="text-sm text-gray-400">{body}</p>
      <p className="text-xs text-gray-500">{need}</p>
    </button>
  );
}
