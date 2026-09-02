import { useState } from 'react';
import AddStationFlow from './AddStationFlow';
import type { AddStationResult } from './AddStationFlow';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleCheck as faCircleCheckDuo,
  faCircleExclamation as faCircleExclamationDuo,
  faCircleQuestion as faCircleQuestionDuo,
  faLinkSlash as faLinkSlashDuo,
  faPlugCircleXmark as faPlugCircleXmarkDuo,
  faPrint as faPrintDuo,
  faPrintSlash as faPrintSlashDuo,
  faFilePdf as faFilePdfDuo,
  faQrcode as faQrcodeDuo,
  faSpinner as faSpinnerDuo,
  faTrash as faTrashDuo,
  faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import QRCode from 'react-qr-code';
import { api } from '../../lib/api';
import { SELLER_SITE_URL } from '../../lib/sellerSiteUrl';
import { lastSeenTitle, recentlySeen, StatusLine, useClockTick } from './hardwareStatus';
import type { HardwareStatus } from './hardwareStatus';
import { deviceLabel } from '../../lib/api.types';
import type {
  CheckinStationRecord,
  DeviceItem,
  DeviceRole,
  StationQueueStatus,
} from '../../lib/api.types';

/** Hardware is only useful once bound to a station, and only to one. */
const BRIDGE_ROLE = 'ski_swap.print_bridge';
const ATTENDANT_ROLE = 'ski_swap.staff_check_in';

/**
 * Where staff set up and watch check-in stations.
 *
 * A station is the durable thing: sellers are sent to "Station 3", and either
 * the bridge or the printer under it can be replaced mid-swap without the
 * queued work noticing. This screen is mostly about seeing that — queue depth
 * and last-seen are how a stuck station gets noticed before a queue forms.
 */
export default function StationsTab({
  orgId,
  devices,
  swapId,
  canAdmin,
  onStationAdded,
}: {
  orgId: string;
  devices: DeviceItem[];
  swapId: string | null;
  canAdmin: boolean;
  /**
   * Handed anything the flow just provisioned. A new tablet has credentials
   * nobody has seen yet and a new bridge has not been near a Bluetooth radio,
   * so both need a screen this component does not own.
   */
  onStationAdded: (result: AddStationResult) => void;
}) {
  const qc = useQueryClient();
  const [showAddForm, setShowAddForm] = useState(false);
  const [showQr, setShowQr] = useState<CheckinStationRecord | null>(null);

  const { data: stations = [], isLoading } = useQuery({
    queryKey: ['ski-swap/stations', orgId],
    queryFn: () => api.skiSwap.listStations(orgId),
    enabled: !!orgId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ski-swap/stations', orgId] });

  const patchStation = useMutation({
    mutationFn: (v: { id: string; data: Parameters<typeof api.skiSwap.patchStation>[2] }) =>
      api.skiSwap.patchStation(orgId, v.id, v.data),
    onSuccess: invalidate,
  });

  /**
   * Provision hardware straight into a station.
   *
   * Two writes, deliberately not one: the device has to exist before it can be
   * bound, and a create that succeeded followed by a bind that failed leaves a
   * usable device in the hardware list rather than nothing at all.
   */
  const provisionInto = useMutation({
    mutationFn: async (v: { stationId: string; role: DeviceRole; name: string }) => {
      const device = await api.devices.provision(orgId, { name: v.name, role: v.role });
      const slot = v.role === 'ski_swap.staff_check_in'
        ? { attendantDeviceId: device.id }
        : { bridgeDeviceId: device.id };
      await api.skiSwap.patchStation(orgId, v.stationId, slot);
      return device;
    },
    onSuccess: (device, variables) => {
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
      void invalidate();
      // The secret is shown once. Handing it up is what stops "Staff it with a
      // new tablet" from minting credentials nobody ever sees — the same loss
      // the add-station flow had, on the path that replaced it.
      onStationAdded({
        stationId: variables.stationId,
        newTablet: variables.role === 'ski_swap.staff_check_in' ? device : null,
        newBridge: variables.role === 'ski_swap.print_bridge' ? device : null,
      });
    },
  });

  const deleteStation = useMutation({
    mutationFn: (id: string) => api.skiSwap.deleteStation(orgId, id),
    onSuccess: invalidate,
  });

  const bridges = devices.filter((d) => d.role === BRIDGE_ROLE);
  const attendants = devices.filter((d) => d.role === ATTENDANT_ROLE);

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-4">
      {canAdmin && (
        <div className="flex justify-end">
          <button
            onClick={() => setShowAddForm(true)}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
          >
            + Add station
          </button>
        </div>
      )}

      {showAddForm && canAdmin && (
        <AddStationFlow
          orgId={orgId}
          // Only hardware nobody is using: a tablet already at a counter is not
          // on offer, and the server would refuse it anyway.
          tablets={attendants.filter((d) => !stations.some((st) => st.attendantDeviceId === d.id))}
          bridges={bridges.filter((d) => !stations.some((st) => st.bridgeDeviceId === d.id))}
          onCancel={() => setShowAddForm(false)}
          onDone={(result) => {
            setShowAddForm(false);
            void invalidate();
            qc.invalidateQueries({ queryKey: ['devices', orgId] });
            onStationAdded(result);
          }}
        />
      )}

      {(provisionInto.error || patchStation.error) && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
          {((provisionInto.error ?? patchStation.error) as Error).message}
        </p>
      )}

      {stations.length === 0 ? (
        <p className="text-sm text-gray-500">
          No check-in stations yet. A station is a counter sellers check in at — either
          one they use themselves by scanning its QR code, or one a volunteer works with
          a tablet.
        </p>
      ) : (
        <ul className="space-y-3">
          {stations.map((station) => (
            <StationRow
              key={station.id}
              orgId={orgId}
              station={station}
              bridges={bridges}
              attendants={attendants}
              swapId={swapId}
              canAdmin={canAdmin}
              onPatch={(data) => patchStation.mutate({ id: station.id, data })}
              onProvision={(role, name) => provisionInto.mutate({ stationId: station.id, role, name })}
              onDelete={() => deleteStation.mutate(station.id)}
              onShowQr={() => setShowQr(station)}
            />
          ))}
        </ul>
      )}

      {showQr && swapId && (
        <QrModal orgId={orgId} station={showQr} swapId={swapId} onClose={() => setShowQr(null)} />
      )}
    </div>
  );
}

function StationRow({
  orgId,
  station,
  bridges,
  attendants,
  swapId,
  canAdmin,
  onPatch,
  onProvision,
  onDelete,
  onShowQr,
}: {
  orgId: string;
  station: CheckinStationRecord;
  bridges: DeviceItem[];
  attendants: DeviceItem[];
  swapId: string | null;
  canAdmin: boolean;
  onPatch: (data: {
    name?: string;
    attendantDeviceId?: string | null;
    bridgeDeviceId?: string | null;
    printerId?: string | null;
  }) => void;
  onProvision: (role: DeviceRole, name: string) => void;
  onDelete: () => void;
  onShowQr: () => void;
}) {
  const qc = useQueryClient();

  // Polled: a station that has stopped printing looks exactly like one that is
  // idle until you can see the depth.
  const { data: queue } = useQuery({
    queryKey: ['ski-swap/stations', orgId, station.id, 'queue'],
    queryFn: () => api.skiSwap.stationQueue(orgId, station.id),
    refetchInterval: 10_000,
  });

  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const test = useMutation({ mutationFn: () => api.skiSwap.testStation(orgId, station.id) });
  const clear = useMutation({
    mutationFn: () => api.skiSwap.clearStationQueue(orgId, station.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/stations', orgId, station.id, 'queue'] }),
  });

  const bridgeSilent = !!queue && queue.queued > 0 && !recentlySeen(queue.bridgeLastSeenAt);
  const printerDown =
    !!queue && queue.queued > 0 && recentlySeen(queue.bridgeLastSeenAt) && queue.printerLink === 'down';

  return (
    <li className="bg-surface-50 border border-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-white font-medium flex items-center gap-2">
            {station.name}
            <span className="text-xs font-mono text-gray-500">code {station.code}</span>
          </h3>
          {/* One line for "can this station print right now", so a row can be
              read at a glance across a venue. The two indicators below say
              which half is at fault. */}
          {queue && <StationStatus station={station} queue={queue} />}
          <p className="text-xs text-gray-500 mt-1">
            Every SKU printed here reads <span className="font-mono">…-{station.code}-nnnn</span>
          </p>
        </div>
        <div className="flex gap-2">
          {/* Hidden only for a staffed station, where a QR is not a missing
              thing but an inapplicable one — staff have the tablet in hand.
              Without a running swap it is disabled and says why, rather than
              vanishing and leaving you looking for it. */}
          {station.kind === 'self_service' && (
            <button
              className="text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-gray-300 rounded disabled:opacity-40"
              disabled={!swapId}
              onClick={onShowQr}
              title={
                swapId
                  ? 'Show the QR code sellers scan'
                  : 'A QR code points at one swap, and none is running. Start one on the Swaps tab.'
              }
            >
              <FontAwesomeIcon icon={faQrcodeDuo} /> QR
            </button>
          )}
          <button
            className="text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-gray-300 rounded disabled:opacity-40"
            disabled={test.isPending || !station.bridgeDeviceId}
            onClick={() => test.mutate()}
            title="Queues a calibration label — exercises server, bridge, BLE, and printer"
          >
            <FontAwesomeIcon icon={faPrintDuo} /> {test.isPending ? 'Queued' : 'Test'}
          </button>
          {canAdmin && (
            <button
              className="text-xs px-2 py-1 bg-surface-100 hover:bg-red-900/40 text-gray-400 hover:text-red-300 rounded"
              onClick={() => setConfirmingDelete(true)}
              title="Retire this station"
            >
              <FontAwesomeIcon icon={faTrashDuo} />
            </button>
          )}
        </div>
      </div>

      {confirmingDelete && (
        // In the row rather than a browser confirm(): what is lost is specific
        // to this station — its code, and whatever hardware is bound to it —
        // and none of that fits in a dialog nobody reads.
        <div className="bg-red-950/30 border border-red-900 rounded p-3 space-y-2">
          <p className="text-sm text-white">Retire {station.name}?</p>
          <p className="text-xs text-gray-400">
            Its code <span className="font-mono">{station.code}</span> stays claimed, so SKUs
            already printed keep meaning what they say — but no new station can use that
            letter.{' '}
            {station.attendantDeviceId || station.bridgeDeviceId
              ? 'Its hardware is released and can be bound elsewhere; nothing is revoked.'
              : 'No hardware is bound to it.'}
          </p>
          <div className="flex gap-2">
            <button
              className="text-xs px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white rounded"
              onClick={() => { setConfirmingDelete(false); onDelete(); }}
            >
              Retire it
            </button>
            <button
              className="text-xs px-3 py-1.5 text-gray-400 hover:text-white"
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Only the slots this kind uses. A self-service station showed an empty
          "Staff tablet" dropdown whose real effect — filling it converts the
          station — was invisible until you did it. Conversion is its own action
          below, where it can be named. */}
      <div className={station.kind === 'staffed' ? 'grid grid-cols-2 gap-3' : ''}>
        {station.kind === 'staffed' && (
          <SlotPicker
            label="Staff tablet"
            emptyLabel="— none —"
            value={station.attendantDeviceId}
            options={attendants}
            canAdmin={canAdmin}
            onChange={(id) => onPatch({ attendantDeviceId: id })}
            onProvision={(name) => onProvision('ski_swap.staff_check_in', name)}
            provisionLabel="New tablet"
          />
        )}

        <SlotPicker
          label={station.kind === 'staffed' ? 'Print bridge (optional)' : 'Print bridge'}
          emptyLabel="— none —"
          value={station.bridgeDeviceId}
          options={bridges}
          canAdmin={canAdmin}
          onChange={(id) => onPatch({ bridgeDeviceId: id })}
          onProvision={(name) => onProvision('ski_swap.print_bridge', name)}
          provisionLabel="New bridge"
        />

      </div>

      <p className="text-xs text-gray-500">
        {station.printerName
          ? <>Prints to <span className="text-gray-300">{station.printerName}</span>, through its bridge.</>
          : station.bridgeDeviceId
            ? 'That bridge has no printer yet — give it one on the Printers page.'
            : station.kind === 'staffed'
              // Stated as the working configuration it is, rather than as a gap:
              // a staffed counter needs no bridge.
              ? 'No bridge — this tablet prints over Bluetooth.'
              : 'A seller has no way to get a tag until this station has a bridge.'}
      </p>

      {canAdmin && (
        <p className="text-xs text-gray-500">
          {station.kind === 'staffed' ? (
            <>
              Staffed — a volunteer checks sellers in here.{' '}
              <button
                className="text-brand-500 hover:underline"
                onClick={() => onPatch({ attendantDeviceId: null })}
                title="Releases the tablet; sellers then scan this station's QR code themselves"
              >
                Make it self-service
              </button>
            </>
          ) : (
            <>
              Self-service — sellers scan this station's QR code.{' '}
              {attendants.length > 0 ? (
                <button
                  className="text-brand-500 hover:underline"
                  onClick={() => onPatch({ attendantDeviceId: attendants[0].id })}
                  title={`Puts ${attendants[0].name} at this counter`}
                >
                  Staff it with {attendants[0].name}
                </button>
              ) : (
                <button
                  className="text-brand-500 hover:underline"
                  onClick={() => onProvision('ski_swap.staff_check_in', `${station.name} tablet`)}
                  title="Provisions a tablet and puts it at this counter"
                >
                  Staff it with a new tablet
                </button>
              )}
            </>
          )}
        </p>
      )}

      {queue && (
        <div className="flex items-center gap-4 text-xs text-gray-400 border-t border-gray-800 pt-3">
          <span>{queue.queued} queued</span>
          <span>{queue.claimed} printing</span>
          {queue.failed > 0 && <span className="text-amber-400">{queue.failed} failed</span>}
          {queue.abandoned > 0 && (
            <span className="text-amber-400">{queue.abandoned} gave up</span>
          )}
          {queue.queued > 0 && canAdmin && (
            <button
              className="ml-auto text-gray-500 hover:text-red-300"
              onClick={() => clear.mutate()}
              title="Discard queued work nobody wants any more"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {bridgeSilent && (
        <p className="text-xs text-amber-400 flex items-center gap-2">
          <FontAwesomeIcon icon={faTriangleExclamationDuo} />
          Work is queued but the bridge has not checked in. Check its power and wifi.
        </p>
      )}

      {printerDown && (
        <p className="text-xs text-amber-400 flex items-center gap-2">
          <FontAwesomeIcon icon={faTriangleExclamationDuo} />
          The bridge is online but cannot reach its printer. Check the printer&apos;s power
          and that nothing else is paired to it.
        </p>
      )}
    </li>
  );
}

/**
 * The whole station in one line.
 *
 * Ordered by what stops a tag reaching a seller's hand, worst first, so the
 * label always names the thing someone has to go and fix.
 */
function StationStatus({
  station,
  queue,
}: {
  station: CheckinStationRecord;
  queue: StationQueueStatus;
}) {
  // A dead bridge sends nothing, so nothing re-renders this on its own.
  useClockTick();
  return <StatusLine status={rollUp(station, queue)} className="text-sm mt-0.5" />;
}

function rollUp(station: CheckinStationRecord, queue: StationQueueStatus): HardwareStatus {
  const staffed = station.kind === 'staffed';

  // What a station is missing depends on what kind it is: a self-service one
  // cannot work without a bridge, because a seller has no other way to get a
  // tag. A staffed one can — its tablet prints over Bluetooth.
  if (!staffed && !station.bridgeDeviceId) {
    return {
      icon: faLinkSlashDuo,
      label: 'Needs a bridge',
      tone: 'unknown',
      title: 'A self-service station needs a bridge — a seller has no other way to get a tag.',
    };
  }

  // A station reaches its printer through its bridge, so a bridge with nothing
  // plugged in is a station that cannot print — and the fix is on the Printers
  // page, not here.
  if (station.bridgeDeviceId && !station.printerId) {
    return {
      icon: faLinkSlashDuo,
      label: 'Bridge has no printer',
      tone: 'warn',
      title: 'Bind a printer to this bridge on the Printers page.',
    };
  }

  // No bridge on a staffed station: printing goes over the tablet's own
  // Bluetooth, which the server never sees. The tablet checking in is the only
  // thing we can honestly report.
  if (!station.bridgeDeviceId) {
    if (!recentlySeen(queue.attendantLastSeenAt)) {
      return {
        icon: faPlugCircleXmarkDuo,
        label: 'Tablet offline',
        tone: 'bad',
        title: lastSeenTitle(queue.attendantLastSeenAt),
      };
    }
    return {
      icon: faCircleCheckDuo,
      label: 'Ready — prints over Bluetooth',
      tone: 'ok',
      title: 'No bridge is bound, so the tablet drives the printer directly. Whether a tag came out is not visible from here.',
    };
  }

  if (!recentlySeen(queue.bridgeLastSeenAt)) {
    // Nothing can print through the queue, and nothing below is current — the
    // bridge is the source of every other signal here.
    return {
      icon: faPlugCircleXmarkDuo,
      label: 'Offline',
      // Red whether or not work is queued. A counter that cannot print is the
      // same failure before anyone is waiting as after.
      tone: 'bad',
      title: lastSeenTitle(queue.bridgeLastSeenAt),
    };
  }

  if (queue.printerLink === 'down') {
    // "Online, but" because the bridge is answering — this is the printer half
    // failing, and the two send you to different pieces of hardware.
    return { icon: faPrintSlashDuo, label: 'Online, but cannot reach the printer', tone: 'warn' };
  }

  if (queue.printerLink === null) {
    // A bridge that does not report its link. Saying "ready" would be a guess
    // about the half we cannot see.
    return { icon: faCircleQuestionDuo, label: 'Online — printer unconfirmed', tone: 'warn' };
  }

  if (queue.abandoned > 0) {
    return {
      icon: faCircleExclamationDuo,
      label: `${queue.abandoned} label${queue.abandoned === 1 ? '' : 's'} gave up`,
      tone: 'warn',
    };
  }

  if (queue.queued > 0 || queue.claimed > 0) {
    return {
      icon: faSpinnerDuo,
      label: `Printing — ${queue.queued + queue.claimed} in the queue`,
      tone: 'ok',
      spin: true,
    };
  }

  return {
    icon: faCircleCheckDuo,
    label: 'Ready',
    tone: 'ok',
    // Worth saying plainly wherever we claim health: a printer out of labels,
    // jammed, or open still accepts every byte and reports success, so this is
    // never a promise that anything came out.
    title: 'The bridge is online and can reach its printer. It cannot tell whether labels are loaded — check the roll by eye.',
  };
}

/**
 * One hardware slot: pick something already provisioned, or make one here.
 *
 * Provisioning used to mean leaving the station, creating a device, and coming
 * back to bind it — three steps to answer "this counter needs a bridge". The
 * credential still appears in the hardware list; this just saves the round trip.
 */
function SlotPicker({
  label,
  emptyLabel,
  value,
  options,
  canAdmin,
  onChange,
  onProvision,
  provisionLabel,
}: {
  label: string;
  emptyLabel: string;
  value: string | null;
  options: DeviceItem[];
  canAdmin: boolean;
  onChange: (id: string | null) => void;
  onProvision: (name: string) => void;
  provisionLabel: string;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  if (naming) {
    return (
      <div className="block">
        <span className="block text-xs text-gray-400 mb-1">{label}</span>
        <div className="flex gap-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name it"
            className="flex-1 min-w-0 bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          />
          <button
            className="text-xs px-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white rounded"
            disabled={!name.trim()}
            onClick={() => { onProvision(name.trim()); setName(''); setNaming(false); }}
          >
            Add
          </button>
          <button
            className="text-xs px-2 text-gray-400 hover:text-white"
            onClick={() => { setName(''); setNaming(false); }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <label className="block">
      <span className="block text-xs text-gray-400 mb-1">{label}</span>
      <div className="flex gap-1">
        <select
          className="flex-1 min-w-0 bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white disabled:opacity-50"
          disabled={!canAdmin}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
        >
          <option value="">{emptyLabel}</option>
          {options.map((d) => (
            <option key={d.id} value={d.id}>{deviceLabel(d)}</option>
          ))}
        </select>
        {canAdmin && !value && (
          <button
            className="text-xs px-2 bg-surface-100 hover:bg-surface-200 text-gray-300 rounded whitespace-nowrap"
            onClick={() => setNaming(true)}
            title={`Provision a ${provisionLabel.toLowerCase()} and bind it here`}
          >
            + {provisionLabel}
          </button>
        )}
      </div>
    </label>
  );
}

/**
 * The code a seller scans. It encodes the swap and the station — the same pair
 * the server revalidates on every call, so a photograph of it grants nothing
 * beyond starting a check-in at that station.
 */
function QrModal({
  orgId,
  station,
  swapId,
  onClose,
}: {
  orgId: string;
  station: CheckinStationRecord;
  swapId: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = `${SELLER_SITE_URL}/app/checkin?swap=${swapId}&station=${station.id}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not reach the clipboard. Select the address and copy it.');
    }
  }

  /**
   * The sheet is built on the server, where the design template lives — the
   * browser only saves it. The download goes through the API client rather than
   * a link because the session token travels in a header, which a plain
   * navigation cannot carry.
   */
  async function download() {
    setDownloading(true);
    setError(null);
    try {
      const blob = await api.skiSwap.stationQrPdf(orgId, station.id);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `checkin-${station.name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the save in some browsers.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the printable sheet');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-sm w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-white font-medium text-center">{station.name}</h3>

        <div className="flex justify-center">
          {/* Small enough to leave room for the address and the download, big
              enough that a phone reads it off the screen while someone tests a
              station before printing anything. */}
          <div className="bg-white p-2.5 rounded">
            <QRCode value={url} size={140} />
          </div>
        </div>

        <div>
          <span className="block text-xs text-gray-400 mb-1">Address</span>
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-300 font-mono"
            />
            <button
              onClick={copy}
              className="shrink-0 bg-surface-100 hover:bg-surface-200 text-gray-300 border border-gray-700 rounded px-3 text-xs"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>

        {error && <p className="text-red-400 text-xs">{error}</p>}

        <button
          onClick={download}
          disabled={downloading}
          className="w-full py-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm rounded flex items-center justify-center gap-2"
        >
          <FontAwesomeIcon icon={faFilePdfDuo} />
          {downloading ? 'Building…' : 'Download printable sheet'}
        </button>

        <button className="w-full py-2 bg-surface-100 text-gray-300 text-sm rounded" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
