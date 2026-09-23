import { useState } from 'react';
import AddStationForm from './AddStationForm';
import type { AddStationResult, StationKind } from './AddStationForm';
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
  ProvisionedDevice,
  StationQueueStatus,
} from '../../lib/api.types';

/** Hardware is only useful once bound to a station, and only to one. */
const BRIDGE_ROLE = 'ski_swap.print_bridge';
const ATTENDANT_ROLE = 'ski_swap.staff_check_in';

/**
 * Check-in stations, in two tables.
 *
 * The two kinds are separate here because they are separate decisions, made
 * before any hardware exists: a kiosk sellers use alone, or a counter an iPad
 * is stationed at. A staffed station and its iPad are created together and stay
 * together — the iPad can be replaced, but the station is never without one.
 *
 * The server still derives the kind from whether an attendant is bound; nothing
 * about this layout needs a `kind` column.
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
   * Handed anything just provisioned. A new iPad has a secret shown once, and a
   * new bridge has never seen a Bluetooth radio; both need a screen this
   * component does not own.
   */
  onStationAdded: (result: AddStationResult) => void;
}) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState<StationKind | null>(null);
  const [showQr, setShowQr] = useState<CheckinStationRecord | null>(null);
  const [retiring, setRetiring] = useState<CheckinStationRecord | null>(null);

  const { data: stations = [], isLoading } = useQuery({
    queryKey: ['ski-swap/stations', orgId],
    queryFn: () => api.skiSwap.listStations(orgId),
    enabled: !!orgId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ski-swap/stations', orgId] });
  const refreshAll = () => {
    void invalidate();
    void qc.invalidateQueries({ queryKey: ['devices', orgId] });
  };

  const patchStation = useMutation({
    mutationFn: (v: { id: string; data: Parameters<typeof api.skiSwap.patchStation>[2] }) =>
      api.skiSwap.patchStation(orgId, v.id, v.data),
    onSuccess: invalidate,
  });

  /**
   * A fresh pairing code for the iPad at a counter.
   *
   * One action, not two. "Replace iPad" used to provision a new device and
   * revoke the old, which sounds more thorough for a lost tablet and is not:
   * rotating the secret locks the old one out just as completely. All the
   * second button bought was a new row in the devices table, at the cost of
   * resetting the station's last-seen history — so the choice was between two
   * spellings of the same thing, made at the moment someone is trying to get a
   * counter working again.
   */
  const rotateSecret = useMutation({
    mutationFn: async (v: { station: CheckinStationRecord; deviceId: string }) => {
      const { clientSecret } = await api.devices.rotateSecret(orgId, v.deviceId);
      return { v, clientSecret };
    },
    onSuccess: ({ v, clientSecret }) => {
      refreshAll();
      onStationAdded({
        stationId: v.station.id,
        newTablet: {
          id: v.deviceId,
          clientId: devices.find((d) => d.id === v.deviceId)?.clientId ?? '',
          clientSecret,
          name: v.station.name,
          role: ATTENDANT_ROLE,
          orgId,
          createdAt: new Date().toISOString(),
        } as ProvisionedDevice,
      });
    },
  });

  /**
   * Retiring a station takes its iPad with it. The two were set up as one
   * thing; leaving live credentials on a tablet with nowhere to check anyone in
   * is the orphan this page exists to avoid.
   */
  const removeStation = useMutation({
    mutationFn: async (station: CheckinStationRecord) => {
      await api.skiSwap.deleteStation(orgId, station.id);
      if (station.attendantDeviceId) await api.devices.revoke(orgId, station.attendantDeviceId);
    },
    onSuccess: refreshAll,
  });

  const boundBridgeIds = new Set(stations.map((s) => s.bridgeDeviceId).filter(Boolean));
  const freeBridges = devices.filter((d) => d.role === BRIDGE_ROLE && !boundBridgeIds.has(d.id));

  const selfStations = stations.filter((s) => s.kind === 'self_service');
  const staffStations = stations.filter((s) => s.kind === 'staffed');

  const busyError =
    patchStation.error ?? rotateSecret.error ?? removeStation.error;

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  const rowProps = {
    orgId,
    swapId,
    canAdmin,
    bridges: freeBridges,
    onPatch: (id: string, data: Parameters<typeof api.skiSwap.patchStation>[2]) =>
      patchStation.mutate({ id, data }),
    onConfirmRetire: (station: CheckinStationRecord) => setRetiring(station),
  };

  return (
    <div className="space-y-8">
      {busyError && (
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded px-3 py-2">
          {(busyError as Error).message}
        </p>
      )}

      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-medium">Self check-in stations</h2>
            <p className="text-xs text-gray-500">
              Sellers scan the station&apos;s QR code and check themselves in. Every one needs a
              print bridge — it is the only way a seller gets a tag.
            </p>
          </div>
          {canAdmin && (
            <button
              onClick={() => setAdding('self_service')}
              className="shrink-0 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
            >
              + Add Self Check-in Station
            </button>
          )}
        </div>

        {adding === 'self_service' && (
          <AddStationForm
            orgId={orgId}
            kind="self_service"
            bridges={freeBridges}
            onCancel={() => setAdding(null)}
            onDone={(result) => { setAdding(null); refreshAll(); onStationAdded(result); }}
          />
        )}

        <StationTable
          stations={selfStations}
          empty="No self check-in stations yet."
          columns={['Station', 'Code', 'Print bridge', 'Status', '']}
          renderRow={(station) => (
            <SelfStationRow
              key={station.id}
              station={station}
              {...rowProps}
              onShowQr={() => setShowQr(station)}
            />
          )}
        />
      </section>

      <section className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-medium">Staff check-in stations</h2>
            <p className="text-xs text-gray-500">
              A volunteer checks sellers in on an iPad. Each station is created with its own
              iPad and keeps it; a bridge is optional, since the iPad prints over Bluetooth.
            </p>
          </div>
          {canAdmin && (
            <button
              onClick={() => setAdding('staffed')}
              className="shrink-0 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
            >
              + Add Staff Check-in Station
            </button>
          )}
        </div>

        {adding === 'staffed' && (
          <AddStationForm
            orgId={orgId}
            kind="staffed"
            bridges={freeBridges}
            onCancel={() => setAdding(null)}
            onDone={(result) => { setAdding(null); refreshAll(); onStationAdded(result); }}
          />
        )}

        <StationTable
          stations={staffStations}
          empty="No staff check-in stations yet."
          columns={['Station', 'Code', 'iPad', 'Print bridge', 'Status', '']}
          renderRow={(station) => (
            <StaffStationRow
              key={station.id}
              station={station}
              {...rowProps}
              devices={devices}
              onRotateSecret={(deviceId) => rotateSecret.mutate({ station, deviceId })}
              working={rotateSecret.isPending}
            />
          )}
        />
      </section>

      {showQr && swapId && (
        <QrModal orgId={orgId} station={showQr} swapId={swapId} onClose={() => setShowQr(null)} />
      )}

      {retiring && (
        <RetireModal
          station={retiring}
          onCancel={() => setRetiring(null)}
          onConfirm={() => { removeStation.mutate(retiring); setRetiring(null); }}
        />
      )}
    </div>
  );
}

function StationTable({
  stations,
  columns,
  empty,
  renderRow,
}: {
  stations: CheckinStationRecord[];
  columns: string[];
  empty: string;
  renderRow: (station: CheckinStationRecord) => React.ReactNode;
}) {
  if (stations.length === 0) return <p className="text-sm text-gray-500">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
            {columns.map((c, i) => (
              <th key={i} className="font-normal py-2 pr-4 whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>{stations.map(renderRow)}</tbody>
      </table>
    </div>
  );
}

/** Shared cells, so the two tables cannot drift in how they say the same thing. */
function StationCells({ station }: { station: CheckinStationRecord }) {
  return (
    <>
      <td className="py-3 pr-4 align-top">
        <span className="text-white font-medium">{station.name}</span>
      </td>
      <td className="py-3 pr-4 align-top">
        <span className="font-mono text-gray-300">{station.code}</span>
        <span className="block text-xs text-gray-600">…-{station.code}-nnnn</span>
      </td>
    </>
  );
}

/** The bridge cell: change it, or make one if the station has none. */
function BridgeCell({
  station,
  bridges,
  canAdmin,
  onPatch,
  required,
}: {
  station: CheckinStationRecord;
  bridges: DeviceItem[];
  canAdmin: boolean;
  onPatch: (id: string, data: Parameters<typeof api.skiSwap.patchStation>[2]) => void;
  required: boolean;
}) {
  return (
    <td className="py-3 pr-4 align-top">
      <select
        disabled={!canAdmin}
        value={station.bridgeDeviceId ?? ''}
        onChange={(e) => onPatch(station.id, { bridgeDeviceId: e.target.value || null })}
        className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white disabled:opacity-50 max-w-[14rem]"
      >
        {/* A self-service station may not be left without one; a staffed one may. */}
        <option value="">{required ? '— none (needed) —' : '— none —'}</option>
        {station.bridgeDeviceId && !bridges.some((b) => b.id === station.bridgeDeviceId) && (
          <option value={station.bridgeDeviceId}>{station.printerName ?? 'Bound bridge'}</option>
        )}
        {bridges.map((b) => (
          <option key={b.id} value={b.id}>{b.printerName ?? b.name}</option>
        ))}
      </select>
      {/* Bridges are set up on the Printers page, where the Bluetooth handshake
          lives; here they are only chosen. */}
      {canAdmin && required && !station.bridgeDeviceId && (
        <span className="block text-xs text-amber-500/80 mt-1">Needs one</span>
      )}
    </td>
  );
}

/** A queue-aware status cell. Its own query, because it polls per station. */
function StatusCell({ orgId, station }: { orgId: string; station: CheckinStationRecord }) {
  const { data: queue } = useQuery({
    queryKey: ['ski-swap/stations', orgId, station.id, 'queue'],
    queryFn: () => api.skiSwap.stationQueue(orgId, station.id),
    refetchInterval: 5000,
  });
  return (
    <td className="py-3 pr-4 align-top min-w-[13rem]">
      {queue ? <StationStatus station={station} queue={queue} /> : <span className="text-gray-600">…</span>}
      {queue && (queue.queued > 0 || queue.claimed > 0) && (
        <span className="block text-xs text-gray-600">
          {queue.queued} queued · {queue.claimed} printing
        </span>
      )}
    </td>
  );
}

type RowProps = {
  orgId: string;
  swapId: string | null;
  canAdmin: boolean;
  bridges: DeviceItem[];
  onPatch: (id: string, data: Parameters<typeof api.skiSwap.patchStation>[2]) => void;
  onConfirmRetire: (station: CheckinStationRecord) => void;
};

function SelfStationRow({
  station,
  orgId,
  swapId,
  canAdmin,
  bridges,
  onPatch,
  onConfirmRetire,
  onShowQr,
}: RowProps & { station: CheckinStationRecord; onShowQr: () => void }) {
  return (
    <tr className="border-b border-gray-800/60">
      <StationCells station={station} />
      <BridgeCell
        station={station}
        bridges={bridges}
        canAdmin={canAdmin}
        onPatch={onPatch}
        required
      />
      <StatusCell orgId={orgId} station={station} />
      <td className="py-3 align-top text-right whitespace-nowrap">
        <RowActions
          orgId={orgId}
          station={station}
          canAdmin={canAdmin}
          onConfirmRetire={onConfirmRetire}
          extra={
            <button
              className={actionClass}
              disabled={!swapId}
              onClick={onShowQr}
              title={swapId
                ? 'Show the QR code sellers scan'
                : 'A QR code points at one swap, and none is running. Start one on the Swaps tab.'}
            >
              <FontAwesomeIcon icon={faQrcodeDuo} /> QR
            </button>
          }
        />
      </td>
    </tr>
  );
}

function StaffStationRow({
  station,
  orgId,
  canAdmin,
  bridges,
  devices,
  onPatch,
  onConfirmRetire,
  onRotateSecret,
  working,
}: RowProps & {
  station: CheckinStationRecord;
  devices: DeviceItem[];
  onRotateSecret: (deviceId: string) => void;
  working: boolean;
}) {
  const tablet = devices.find((d) => d.id === station.attendantDeviceId);
  return (
    <tr className="border-b border-gray-800/60">
      <StationCells station={station} />
      <td className="py-3 pr-4 align-top">
        <span className="text-gray-300">{tablet ? deviceLabel(tablet) : '—'}</span>
        {canAdmin && tablet && (
          <button
            className="block text-xs text-brand-500 hover:underline disabled:opacity-40 mt-1"
            disabled={working}
            onClick={() => onRotateSecret(tablet.id)}
            title="Issues a new code and locks out the old one — for an iPad that was wiped, reinstalled, lost or swapped"
          >
            New pairing code
          </button>
        )}
      </td>
      <BridgeCell
        station={station}
        bridges={bridges}
        canAdmin={canAdmin}
        onPatch={onPatch}
        required={false}
      />
      <StatusCell orgId={orgId} station={station} />
      <td className="py-3 align-top text-right whitespace-nowrap">
        <RowActions
          orgId={orgId}
          station={station}
          canAdmin={canAdmin}
          onConfirmRetire={onConfirmRetire}
        />
      </td>
    </tr>
  );
}

const actionClass =
  'text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-gray-300 rounded disabled:opacity-40';

/** Test and retire, plus whatever the kind adds. */
function RowActions({
  orgId,
  station,
  canAdmin,
  onConfirmRetire,
  extra,
}: {
  orgId: string;
  station: CheckinStationRecord;
  canAdmin: boolean;
  onConfirmRetire: (station: CheckinStationRecord) => void;
  extra?: React.ReactNode;
}) {
  const test = useMutation({ mutationFn: () => api.skiSwap.testStation(orgId, station.id) });

  return (
    <span className="space-x-1">
      {extra}
      <button
        className={actionClass}
        disabled={test.isPending || !station.bridgeDeviceId}
        onClick={() => test.mutate()}
        title="Queues a calibration label — exercises server, bridge, BLE, and printer"
      >
        <FontAwesomeIcon icon={faPrintDuo} /> {test.isPending ? 'Queued' : 'Test'}
      </button>
      {canAdmin && (
        <button
          className="text-xs px-2 py-1 bg-surface-100 hover:bg-red-900/40 text-gray-400 hover:text-red-300 rounded"
          onClick={() => onConfirmRetire(station)}
          title="Retire this station"
        >
          <FontAwesomeIcon icon={faTrashDuo} />
        </button>
      )}
    </span>
  );
}

/**
 * Retiring a station, asked in a dialog rather than in the row.
 *
 * It lived in the last table cell, where it was clipped by the column and
 * pushed a horizontal scrollbar under the table — a warning about something
 * irreversible, cut off mid-sentence. What is being given up needs room to be
 * read: the code letter, and the iPad that goes with it.
 */
function RetireModal({
  station,
  onCancel,
  onConfirm,
}: {
  station: CheckinStationRecord;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onCancel}
    >
      <div
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-md w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-white font-medium">Retire {station.name}?</h3>

        <div className="space-y-2 text-sm text-gray-400">
          <p>
            Its code <span className="font-mono text-gray-200">{station.code}</span> stays
            claimed, so tags already printed here keep meaning what they say. No new station
            can use that letter — an organization has 32 and they are never reused.
          </p>
          {station.attendantDeviceId && (
            <p>Its iPad is revoked at the same time and will stop being able to check anyone in.</p>
          )}
          {station.bridgeDeviceId && (
            <p>Its print bridge is released and can be bound to another station.</p>
          )}
        </div>

        <div className="flex gap-2 justify-end">
          <button className="text-sm text-gray-400 hover:text-white px-3 py-2" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="bg-red-700 hover:bg-red-600 text-white px-4 py-2 rounded text-sm"
            onClick={onConfirm}
          >
            Retire it
          </button>
        </div>
      </div>
    </div>
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
