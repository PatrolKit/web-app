import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBluetooth,
  faCircleCheck as faCircleCheckDuo,
  faCircleQuestion as faCircleQuestionDuo,
  faLinkSlash as faLinkSlashDuo,
  faPlugCircleXmark as faPlugCircleXmarkDuo,
  faPrint as faPrintDuo,
  faPrintSlash as faPrintSlashDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';
import {
  connectFromDevice,
  DEFAULT_PRINTER_MARGINS,
  isWebBluetoothSupported,
  PAPER_SIZE_LABELS,
  PRINTER_ADVERTISED_FILTERS,
  paperSizesFor,
  PRINTER_MODEL_LABELS,
  PRINTER_MODELS,
} from '../../lib/printing/PhomemoPrinterService';
import type {
  PaperSize, PrinterMargins, PrinterModelId,
} from '../../lib/printing/PhomemoPrinterService';
import { usePrinter } from '../../contexts/PrinterContext';
import { DeviceCredentialList, MutationError } from '../devices/DeviceCredentials';
import {
  lastSeenTitle,
  OFFLINE_AFTER_UNBOUND_MS,
  recentlySeen,
  StatusLine,
  useClockTick,
} from '../devices/hardwareStatus';
import type { HardwareStatus } from '../devices/hardwareStatus';
import type { DeviceItem, DeviceRole, SwapPrinterRecord } from '../../lib/api.types';
import BridgeEditModal from './BridgeEditModal';
import BridgePeripherals from './BridgePeripherals';
import ScannersSection from './ScannersSection';
import type { SkiSwapContext } from './SkiSwapLayout';

/** What 25 × 67 stock means for a printer (Plan 28). */
const HELPER_STOCK_NOTE =
  'Legacy helper labels only. A bridge driving this printer prints the stickers its stations’ iPads ask for, and refuses tags and receipts.';

/** A bridge is the printer's network adapter, so it is managed alongside them. */
const BRIDGE_ROLE: DeviceRole = 'ski_swap.print_bridge';

/**
 * The Phomemos an org owns: what they are called, what paper they carry, and
 * the margins each one needs.
 *
 * Ski-swap hardware, so it lives with ski swap. It used to sit under a Devices
 * nav item gated on `devices:read` — which the ski-swap admin who configures
 * these does not hold, so the person whose job this is could not open the page.
 */
export default function PrintersPage() {
  const { orgId, perms } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const { registerConnection, printPrinterIdLabel } = usePrinter();
  const canManagePrinters = perms.has('ski_swap:admin');
  const [pendingTestPrint, setPendingTestPrint] = useState<SwapPrinterRecord | null>(null);
  const [isPrintingId, setIsPrintingId] = useState<string | null>(null);
  const [editingBridge, setEditingBridge] = useState<DeviceItem | null>(null);
  // Bridge status is judged against the clock, and a dead bridge sends nothing —
  // so without this the page never re-renders to notice one has gone quiet.
  // Called here rather than in BridgeStatus, which is invoked as a plain
  // function per row and would run a hook a variable number of times.
  useClockTick();
  /** True when the edit screen opened straight off provisioning. */
  const [bridgeIsNew, setBridgeIsNew] = useState(false);

  function openBridge(bridge: DeviceItem, isNew = false) {
    setBridgeIsNew(isNew);
    setEditingBridge(bridge);
  }


  // ─── Printers state ───────────────────────────────────────────────────────
  const [printerName, setPrinterName] = useState('');
  const [printerBtName, setPrinterBtName] = useState('');
  const [printerModel, setPrinterModel] = useState<PrinterModelId | ''>('');
  const [printerPaperSize, setPrinterPaperSize] = useState<PaperSize | ''>('');
  // Holds the BluetoothDevice from the scan so the first print needs no picker
  const scannedDeviceRef = useRef<BluetoothDevice | null>(null);
  const [showPrinterForm, setShowPrinterForm] = useState(false);
  const [printerFormError, setPrinterFormError] = useState<string | null>(null);
  const [editingPrinter, setEditingPrinter] = useState<SwapPrinterRecord | null>(null);
  const [editPrinterName, setEditPrinterName] = useState('');
  const [editMargins, setEditMargins] = useState<PrinterMargins>(DEFAULT_PRINTER_MARGINS);

  const { data: printers = [] } = useQuery({
    queryKey: ['ski-swap/printers', orgId],
    queryFn: () => api.skiSwap.listPrinters(orgId),
    enabled: !!orgId && canManagePrinters,
  });

  const createPrinterMutation = useMutation({
    mutationFn: () => api.skiSwap.createPrinter(orgId, { name: printerName, bluetoothName: printerBtName, model: printerModel as PrinterModelId, paperSize: printerPaperSize as PaperSize }),
    onSuccess: async (created) => {
      qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] });
      setShowPrinterForm(false);
      setPrinterFormError(null);
      setPrinterName('');
      setPrinterBtName('');
      setPrinterPaperSize('');
      // Grab and clear the ref synchronously so handleTestPrint won't double-connect
      const heldDevice = scannedDeviceRef.current;
      scannedDeviceRef.current = null;
      setPendingTestPrint(created);
      // Proactively connect so the nav bar shows connected and the test print needs no picker
      if (heldDevice) {
        try {
          const conn = await connectFromDevice(heldDevice);
          registerConnection(created, conn);
        } catch { /* ignore — user can connect via nav bar */ }
      }
    },
    onError: (err: Error) => setPrinterFormError(err.message),
  });

  async function handleTestPrint(printer: SwapPrinterRecord) {
    if (!isWebBluetoothSupported()) { alert('Printing requires Chrome or Edge.'); return; }
    setIsPrintingId(printer.id);
    try {
      if (scannedDeviceRef.current) {
        const conn = await connectFromDevice(scannedDeviceRef.current);
        scannedDeviceRef.current = null;
        registerConnection(printer, conn);
      }
      await printPrinterIdLabel(printer);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'NotFoundError')
        alert(`Print failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setIsPrintingId(null);
    }
  }

  // Shared query key with ScannersSection, so react-query fetches this once.
  const { data: scanners = [] } = useQuery({
    queryKey: ['ski-swap/scanners', orgId],
    queryFn: () => api.skiSwap.listScanners(orgId),
    enabled: !!orgId,
  });

  const patchPrinterMutation = useMutation({
    mutationFn: (data: { name?: string; assignedSellerId?: string | null; paperSize?: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number }) =>
      api.skiSwap.patchPrinter(orgId, editingPrinter!.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] }); setEditingPrinter(null); },
  });

  function BridgeStatus(bridge: DeviceItem) {
    const bound = printers.find((p: SwapPrinterRecord) => p.bridgeDeviceId === bridge.id);
    return (
      <>
        <StatusLine status={rollUpBridge(bridge, bound)} className="text-sm mt-1" />
        {/* Its own line rather than folded into the status: whether the box
            works and whether anything routes work to it are separate questions
            with separate fixes, on separate pages. */}
        {!bridge.stationName && (
          <p className="text-xs text-gray-500 mt-0.5">
            Not serving a station — bind it to one on the Check-in page.
          </p>
        )}
        <BridgePeripherals
          orgId={orgId}
          bridge={bridge}
          printers={printers}
          scanners={scanners}
          canAdmin={canManagePrinters}
        />
      </>
    );
  }

  const deletePrinterMutation = useMutation({
    mutationFn: (id: string) => api.skiSwap.deletePrinter(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] }),
  });

  /**
   * Shows the BLE picker and captures what was chosen.
   *
   * Filtered on what each printer announces: `FF00` for an M110, `AF30` for an
   * M221. That second one was read off the hardware after an M221 never appeared
   * in a list filtered on `FF00` alone — `FF00` is what both print through, and
   * the M221 simply does not advertise it.
   *
   * Name prefixes would not help, whatever they did for scanners. Both printers
   * we own advertise an opaque serial — `Q192E28B1060137` is an M110,
   * `Q454E62S2530017` an M221 — so a name says nothing about what a device is,
   * and the model is a dropdown against the label on the hardware.
   */
  async function scanAnyPrinter() {
    if (!isWebBluetoothSupported()) { alert('Printing requires Chrome or Edge.'); return; }
    const PHOMEMO = '0000ff00-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID;
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: PRINTER_ADVERTISED_FILTERS,
        optionalServices: [PHOMEMO],
      });
      setPrinterBtName(device.name ?? '');
      scannedDeviceRef.current = device; // keep alive for first print — no disconnect
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'NotFoundError') alert(`Scan failed: ${(err as Error)?.message ?? err}`);
    }
  }

  if (!canManagePrinters) {
    return <p className="text-gray-400 text-sm">You do not have access to printer configuration.</p>;
  }

  return (
    <div className="space-y-6">
        <div className="space-y-3">
          <div>
            <h2 className="text-white font-medium">Printers</h2>
            <p className="text-xs text-gray-500">
              The Phomemos this org owns: what paper each one carries and the margins it
              needs. A printer is reached either through a bridge below, or over Bluetooth
              from whoever is holding it.
            </p>
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => { setShowPrinterForm(true); setPrinterName(''); setPrinterBtName(''); setPrinterModel(''); setPrinterPaperSize(''); setPrinterFormError(null); }}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
            >
              + Provision Printer
            </button>
          </div>

          {showPrinterForm && (
            <form
              onSubmit={(e) => { e.preventDefault(); createPrinterMutation.mutate(); }}
              className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
            >
              <h3 className="text-white font-medium">Provision Printer</h3>
              <input
                value={printerName}
                onChange={(e) => setPrinterName(e.target.value)}
                placeholder="Friendly name (e.g. Printer A)"
                required
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
              <div className="flex gap-2">
                <input
                  value={printerBtName}
                  placeholder="Populated by scan"
                  disabled
                  className={`flex-1 border rounded px-3 py-2 text-sm font-mono ${
                    printerBtName
                      ? 'bg-surface-50 border-gray-700 text-green-400'
                      : 'bg-surface-50 border-gray-700 text-gray-500'
                  }`}
                />
                <button
                  type="button"
                  onClick={scanAnyPrinter}
                  className="bg-surface-100 hover:bg-surface-200 text-gray-300 px-3 py-2 rounded text-sm flex items-center gap-1"
                >
                  <FontAwesomeIcon icon={faBluetooth} /> Scan
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Wake the printer first — it has to be advertising to appear. Pick the model
                below from the label on the hardware: a printer's Bluetooth name is a serial
                number and says nothing about which one it is.
              </p>
              <select
                value={printerModel}
                onChange={(e) => {
                  const m = e.target.value as PrinterModelId;
                  setPrinterModel(m);
                  const sizes = paperSizesFor(m);
                  setPrinterPaperSize(sizes.length === 1 ? sizes[0] : '');
                }}
                required
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              >
                <option value="" disabled>Printer model (required)</option>
                {PRINTER_MODELS.map((m) => (
                  <option key={m} value={m}>{PRINTER_MODEL_LABELS[m]}</option>
                ))}
              </select>
              {/* Stock wider than the head is unprintable, so the sizes on offer
                  depend on the model — which is why it has to be settled first. */}
              <select
                value={printerPaperSize}
                onChange={(e) => setPrinterPaperSize(e.target.value as PaperSize)}
                required
                disabled={!printerModel}
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white disabled:opacity-40"
              >
                <option value="" disabled>
                  {printerModel ? 'Paper size (required)' : 'Pick the model first'}
                </option>
                {printerModel && paperSizesFor(printerModel).map((size) => (
                  <option key={size} value={size}>{PAPER_SIZE_LABELS[size]}</option>
                ))}
              </select>
              {printerPaperSize === '25x67' && <p className="text-xs text-gray-500">{HELPER_STOCK_NOTE}</p>}
              {printerFormError && <p className="text-red-400 text-xs">{printerFormError}</p>}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => { setShowPrinterForm(false); scannedDeviceRef.current = null; setPrinterFormError(null); }} className="text-sm text-gray-400 hover:text-white px-3 py-2">Cancel</button>
                <button
                  type="submit"
                  disabled={createPrinterMutation.isPending || !printerName || !printerBtName || !printerModel || !printerPaperSize}
                  className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
                >
                  {createPrinterMutation.isPending ? 'Provisioning…' : 'Provision'}
                </button>
              </div>
            </form>
          )}

          {editingPrinter && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
              <form
                className="bg-surface-200 rounded-lg p-6 w-full max-w-sm space-y-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  patchPrinterMutation.mutate({ name: editPrinterName, ...editMargins });
                }}
              >
                <h2 className="text-white font-semibold">Edit Printer</h2>
                <input
                  value={editPrinterName}
                  onChange={(e) => setEditPrinterName(e.target.value)}
                  required
                  className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                />
                {/* Reported, not chosen. Which printer a seller gets is a fact
                    about the seller — and the alternative to giving them one is
                    issuing them tickets, which this screen knows nothing about.
                    Releasing it stays here, because that is about the printer. */}
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Assigned to</label>
                  {editingPrinter.assignedSellerName ? (
                    <div className="flex items-center gap-3">
                      <span className="text-sm text-white">{editingPrinter.assignedSellerName}</span>
                      <button
                        type="button"
                        onClick={() => patchPrinterMutation.mutate({ assignedSellerId: null })}
                        disabled={patchPrinterMutation.isPending}
                        className="text-xs text-red-500 hover:underline disabled:opacity-40"
                      >
                        Unassign
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500">
                      Org pool — assign it on the seller&apos;s own page.
                    </p>
                  )}
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Paper size</label>
                  <select
                    value={editingPrinter.paperSize}
                    onChange={(e) => patchPrinterMutation.mutate({ paperSize: e.target.value as PaperSize })}
                    className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                  >
                    {paperSizesFor(editingPrinter.model).map((size) => (
                      <option key={size} value={size}>{PAPER_SIZE_LABELS[size]}</option>
                    ))}
                  </select>
                  {editingPrinter.paperSize === '25x67' && <p className="text-xs text-gray-500 mt-1">{HELPER_STOCK_NOTE}</p>}
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Margins (dots)</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['marginTop', 'marginBottom', 'marginLeft', 'marginRight'] as const).map((key) => (
                      <div key={key}>
                        <label className="text-xs text-gray-600 block mb-0.5 capitalize">{key.replace('margin', '')}</label>
                        <input
                          type="number" min={0} max={160}
                          value={editMargins[key]}
                          onChange={(e) => setEditMargins((m) => ({ ...m, [key]: parseInt(e.target.value, 10) || 0 }))}
                          className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
                        />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2 pt-2">
                  <button type="submit" disabled={patchPrinterMutation.isPending} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded py-1.5 disabled:opacity-40">Save</button>
                  <button type="button" onClick={() => setEditingPrinter(null)} className="flex-1 bg-surface-100 text-gray-300 text-sm rounded py-1.5">Cancel</button>
                </div>
              </form>
            </div>
          )}

          <div className="space-y-2">
            <MutationError error={patchPrinterMutation.error ?? deletePrinterMutation.error} />

            {printers.map((p: SwapPrinterRecord) => (
              <div key={p.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <p className="text-white font-medium">{p.name}</p>
                  <p className="text-xs text-gray-500 font-mono">{p.bluetoothName}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {p.assignedSellerName ? `Assigned to: ${p.assignedSellerName}` : 'Org pool'}{' · '}{PRINTER_MODEL_LABELS[p.model]}{' · '}{PAPER_SIZE_LABELS[p.paperSize]}
                  </p>
                  <p className="text-xs text-gray-600 font-mono mt-0.5">
                    T:{p.marginTop} B:{p.marginBottom} L:{p.marginLeft} R:{p.marginRight}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {/* Naming the bridge here would echo this row: a bridge is
                        called after the printer it drives. */}
                    {p.bridgeDeviceId
                      ? p.stationName
                        ? <>On the network, serving <span className="text-gray-300">{p.stationName}</span></>
                        : 'On the network via its bridge — no station yet'
                      : 'No bridge — prints over Bluetooth'}
                  </p>
                </div>
                {/* No Calibrate or Print label here. Both need a live Bluetooth
                    link, and this is a list of every printer the org owns —
                    including ones driven by a bridge, and ones nobody at this
                    machine is connected to. They live in the printer menu in the
                    nav bar, which is where the connection is. */}
                <div className="flex gap-2 items-center">
                  <button
                    onClick={() => {
                      setEditingPrinter(p); setEditPrinterName(p.name);
                      setEditMargins({ marginTop: p.marginTop, marginBottom: p.marginBottom, marginLeft: p.marginLeft, marginRight: p.marginRight });
                    }}
                    className="text-xs text-brand-500 hover:underline"
                  >Edit</button>
                  <button
                    onClick={() => { if (confirm(`Remove "${p.name}"?`)) deletePrinterMutation.mutate(p.id); }}
                    className="text-xs text-red-500 hover:underline"
                  >Remove</button>
                </div>
              </div>
            ))}
            {printers.length === 0 && <p className="text-gray-500 text-sm">No printers provisioned yet.</p>}
          </div>
        </div>

      <div className="space-y-3 border-t border-gray-800 pt-6">
        <div>
          <h2 className="text-white font-medium">Print bridges</h2>
          <p className="text-xs text-gray-500">
            A bridge puts a printer and a scanner on the network so a check-in station can
            reach them. Pick what each one drives below; the board is told on its next
            check-in, so nothing needs resetting. Bind the bridge itself to a station on the
            Check-in stations page.
          </p>
        </div>
        <DeviceCredentialList
          orgId={orgId}
          role={BRIDGE_ROLE}
          canProvision={canManagePrinters}
          renderExtra={BridgeStatus}
          onEdit={openBridge}
          onProvisioned={(d) =>
            // The provision response carries only what the server just wrote;
            // the rest arrives on the next poll of the devices list.
            openBridge(
              { ...d, lastSeenAt: null, printerLink: null, printerLinkAt: null, printerName: null },
              true,
            )
          }
        />
      </div>

      <ScannersSection orgId={orgId} canAdmin={canManagePrinters} />

      {editingBridge && (
        <BridgeEditModal
          orgId={orgId}
          bridge={editingBridge}
          justProvisioned={bridgeIsNew}
          onClose={() => { setEditingBridge(null); setBridgeIsNew(false); }}
        />
      )}

      {/* Post-registration test print popup */}
      {pendingTestPrint && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-200 rounded-lg p-6 w-full max-w-sm space-y-4">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <FontAwesomeIcon icon={faPrintDuo} className="text-brand-400" /> Printer Provisioned
            </h2>
            <p className="text-gray-400 text-sm">
              <strong className="text-white">{pendingTestPrint.name}</strong> was provisioned successfully.
              Would you like to print an identification label now?
            </p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => { handleTestPrint(pendingTestPrint); setPendingTestPrint(null); }}
                disabled={isPrintingId !== null}
                className="flex-1 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-sm rounded py-1.5 flex items-center justify-center gap-1"
              >
                <FontAwesomeIcon icon={faPrintDuo} /> Print Label
              </button>
              <button
                onClick={() => setPendingTestPrint(null)}
                className="flex-1 bg-surface-100 text-gray-300 text-sm rounded py-1.5"
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A bridge in one line, worst first — the same verdicts the station card gives,
 * asked of the box rather than the counter.
 *
 * The station orders config gaps ahead of liveness because a station with no
 * bridge has no liveness to report. Here the box is in front of us either way,
 * so liveness leads: a bridge that never reached the server is the failure to
 * name, and "no printer" is a dropdown away once it is alive.
 *
 * Nothing here is inferred. A bridge reports its printer link on every claim,
 * and a link it has not spoken about is reported as unknown rather than
 * guessed at — saying "ready" about a half we cannot see is how a dead bridge
 * came to look provisioned in the first place.
 */
function rollUpBridge(bridge: DeviceItem, printer: SwapPrinterRecord | undefined): HardwareStatus {
  if (!bridge.lastSeenAt) {
    return {
      icon: faPlugCircleXmarkDuo,
      label: 'Never connected',
      tone: 'bad',
      title: 'This bridge has never reached the server. Set it up over Bluetooth, or check its firmware.',
    };
  }

  // An unbound bridge calls in on a slow retry rather than a heartbeat, so it is
  // judged against that cadence. Holding it to the heartbeat rule would report a
  // perfectly healthy box as offline half the time.
  const serving = !!bridge.stationName;
  if (!recentlySeen(bridge.lastSeenAt, serving ? undefined : OFFLINE_AFTER_UNBOUND_MS)) {
    // Every signal below comes from the bridge itself, so once it goes quiet
    // none of them are current and reporting them would be reporting history.
    return {
      icon: faPlugCircleXmarkDuo,
      label: 'Offline',
      tone: 'bad',
      title: lastSeenTitle(bridge.lastSeenAt),
    };
  }

  if (!printer) {
    return {
      icon: faLinkSlashDuo,
      label: 'Online — no printer',
      tone: 'warn',
      title: 'The bridge is reaching the server but drives nothing. Set it up and pick its printer.',
    };
  }

  if (bridge.printerLink === 'down') {
    return {
      icon: faPrintSlashDuo,
      label: 'Online, but cannot reach the printer',
      tone: 'warn',
      title: `Printer power, or something else paired to ${printer.bluetoothName}.`,
    };
  }

  // Anything that is not an explicit `ready` is unconfirmed — null from a bridge
  // that has not reported yet, and undefined from a server too old to send the
  // field at all. Testing for the absences instead would let an unrecognised
  // value fall through to green, which is the exact way a bridge with no working
  // printer came to look fine.
  if (bridge.printerLink !== 'ready') {
    return {
      icon: faCircleQuestionDuo,
      label: 'Online — printer unconfirmed',
      tone: 'warn',
      title: 'The bridge has not reported its printer link. It reports one on each claim, so this clears itself within a few seconds — unless the firmware is too old to send it.',
    };
  }

  // A `ready` from a bridge that has since gone quiet is caught above, so
  // reaching here means both halves are current.
  return {
    icon: faCircleCheckDuo,
    label: serving ? 'Ready' : 'Online, printer connected',
    tone: 'ok',
    title: `Reaching the server, and holding the link to ${printer.name}.`,
  };
}
