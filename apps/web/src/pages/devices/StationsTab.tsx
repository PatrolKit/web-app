import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faPrint as faPrintDuo,
  faQrcode as faQrcodeDuo,
  faTrash as faTrashDuo,
  faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import QRCode from 'react-qr-code';
import { api } from '../../lib/api';
import { SELLER_SITE_URL } from '../../lib/sellerSiteUrl';
import type { CheckinStationRecord, DeviceItem, SwapPrinterRecord } from '../../lib/api.types';

/** A bridge is only useful once bound to a station, and only to one. */
const ADAPTER_ROLE = 'Ski Swap - Network Printer Adapter';

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
  printers,
  swapId,
  canAdmin,
}: {
  orgId: string;
  devices: DeviceItem[];
  printers: SwapPrinterRecord[];
  swapId: string | null;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [newName, setNewName] = useState('');
  const [showQr, setShowQr] = useState<CheckinStationRecord | null>(null);

  const { data: stations = [], isLoading } = useQuery({
    queryKey: ['ski-swap/stations', orgId],
    queryFn: () => api.skiSwap.listStations(orgId),
    enabled: !!orgId,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['ski-swap/stations', orgId] });

  const createStation = useMutation({
    mutationFn: () => api.skiSwap.createStation(orgId, newName.trim()),
    onSuccess: () => { setNewName(''); void invalidate(); },
  });

  const patchStation = useMutation({
    mutationFn: (v: { id: string; data: Parameters<typeof api.skiSwap.patchStation>[2] }) =>
      api.skiSwap.patchStation(orgId, v.id, v.data),
    onSuccess: invalidate,
  });

  const deleteStation = useMutation({
    mutationFn: (id: string) => api.skiSwap.deleteStation(orgId, id),
    onSuccess: invalidate,
  });

  const bridges = devices.filter((d) => d.role === ADAPTER_ROLE);

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-4">
      {canAdmin && (
        <div className="flex gap-2">
          <input
            className="flex-1 bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-sm text-white"
            placeholder="Station name, e.g. Station 3"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 text-white text-sm rounded"
            disabled={!newName.trim() || createStation.isPending}
            onClick={() => createStation.mutate()}
          >
            Add station
          </button>
        </div>
      )}

      {createStation.error && (
        <p className="text-sm text-red-400">
          {(createStation.error as Error).message}
        </p>
      )}

      {stations.length === 0 ? (
        <p className="text-sm text-gray-500">
          No check-in stations yet. A station is a QR code, a bridge, and a printer —
          sellers scan the code and their tags come out here.
        </p>
      ) : (
        <ul className="space-y-3">
          {stations.map((station) => (
            <StationRow
              key={station.id}
              orgId={orgId}
              station={station}
              bridges={bridges}
              printers={printers}
              swapId={swapId}
              canAdmin={canAdmin}
              onPatch={(data) => patchStation.mutate({ id: station.id, data })}
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
  printers,
  swapId,
  canAdmin,
  onPatch,
  onDelete,
  onShowQr,
}: {
  orgId: string;
  station: CheckinStationRecord;
  bridges: DeviceItem[];
  printers: SwapPrinterRecord[];
  swapId: string | null;
  canAdmin: boolean;
  onPatch: (data: { name?: string; deviceId?: string | null; printerId?: string | null }) => void;
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

  const test = useMutation({ mutationFn: () => api.skiSwap.testStation(orgId, station.id) });
  const clear = useMutation({
    mutationFn: () => api.skiSwap.clearStationQueue(orgId, station.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/stations', orgId, station.id, 'queue'] }),
  });

  const stalled = !!queue && queue.queued > 0 && !recentlySeen(queue.deviceLastSeenAt);

  return (
    <li className="bg-surface-50 border border-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-white font-medium">
            {station.name}
            <span className="ml-2 text-xs font-mono text-gray-500">code {station.code}</span>
          </h3>
          <p className="text-xs text-gray-500">
            Every SKU printed here reads <span className="font-mono">…-{station.code}-nnnn</span>
          </p>
        </div>
        <div className="flex gap-2">
          {swapId && (
            <button
              className="text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-gray-300 rounded"
              onClick={onShowQr}
              title="Show the QR code sellers scan"
            >
              <FontAwesomeIcon icon={faQrcodeDuo} /> QR
            </button>
          )}
          <button
            className="text-xs px-2 py-1 bg-surface-100 hover:bg-surface-200 text-gray-300 rounded disabled:opacity-40"
            disabled={test.isPending || !station.deviceId}
            onClick={() => test.mutate()}
            title="Queues a calibration label — exercises server, bridge, BLE, and printer"
          >
            <FontAwesomeIcon icon={faPrintDuo} /> {test.isPending ? 'Queued' : 'Test'}
          </button>
          {canAdmin && (
            <button
              className="text-xs px-2 py-1 bg-surface-100 hover:bg-red-900/40 text-gray-400 hover:text-red-300 rounded"
              onClick={onDelete}
              title="Retire this station"
            >
              <FontAwesomeIcon icon={faTrashDuo} />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">Bridge</span>
          <select
            className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={!canAdmin}
            value={station.deviceId ?? ''}
            onChange={(e) => onPatch({ deviceId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {bridges.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">Printer</span>
          <select
            className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white disabled:opacity-50"
            disabled={!canAdmin}
            value={station.printerId ?? ''}
            onChange={(e) => onPatch({ printerId: e.target.value || null })}
          >
            <option value="">— none —</option>
            {printers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
      </div>

      {queue && (
        <div className="flex items-center gap-4 text-xs text-gray-400 border-t border-gray-800 pt-3">
          <span>{queue.queued} queued</span>
          <span>{queue.claimed} printing</span>
          {queue.failed > 0 && <span className="text-amber-400">{queue.failed} failed</span>}
          {queue.abandoned > 0 && (
            <span className="text-amber-400">{queue.abandoned} gave up</span>
          )}
          <span className="ml-auto">
            Bridge {station.deviceId ? lastSeenLabel(queue.deviceLastSeenAt) : 'not assigned'}
          </span>
          {queue.queued > 0 && canAdmin && (
            <button
              className="text-gray-500 hover:text-red-300"
              onClick={() => clear.mutate()}
              title="Discard queued work nobody wants any more"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {stalled && (
        <p className="text-xs text-amber-400 flex items-center gap-2">
          <FontAwesomeIcon icon={faTriangleExclamationDuo} />
          Work is queued but the bridge has not checked in. Check its power and wifi.
        </p>
      )}
    </li>
  );
}

/** A bridge polls about once a second, so a minute of silence is a real signal. */
function recentlySeen(iso: string | null): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < 60_000;
}

function lastSeenLabel(iso: string | null): string {
  if (!iso) return 'never seen';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'online';
  if (seconds < 3600) return `quiet ${Math.round(seconds / 60)}m`;
  return `quiet ${Math.round(seconds / 3600)}h`;
}

/**
 * The code a seller scans. It encodes the swap and the station — the same pair
 * the server revalidates on every call, so a photograph of it grants nothing
 * beyond starting a check-in at that station.
 */
function QrModal({
  station,
  swapId,
  onClose,
}: {
  orgId: string;
  station: CheckinStationRecord;
  swapId: string;
  onClose: () => void;
}) {
  const url = `${SELLER_SITE_URL}/app/checkin?swap=${swapId}&station=${station.id}`;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-xs w-full space-y-4 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-white font-medium">{station.name}</h3>
        <div className="bg-white p-3 rounded inline-block">
          <QRCode value={url} size={200} />
        </div>
        <p className="text-xs text-gray-500 break-all">{url}</p>
        <button className="w-full py-2 bg-surface-100 text-gray-300 text-sm rounded" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
