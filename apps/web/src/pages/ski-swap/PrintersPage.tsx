import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBluetooth, faPrint as faPrintDuo } from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';
import {
  connectFromDevice,
  DEFAULT_PRINTER_MARGINS,
  isWebBluetoothSupported,
} from '../../lib/printing/PhomemoPrinterService';
import type { PrinterMargins } from '../../lib/printing/PhomemoPrinterService';
import { usePrinter } from '../../contexts/PrinterContext';
import { DeviceCredentialList, MutationError } from '../devices/DeviceCredentials';
import type { DeviceItem, DeviceRole, SellerResponse, SwapPrinterRecord } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

/** A bridge is the printer's network adapter, so it is managed alongside them. */
const BRIDGE_ROLES: readonly DeviceRole[] = ['ski_swap.print_bridge'];

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
  const { registerConnection, printPrinterIdLabel, printCalibration } = usePrinter();
  const canManagePrinters = perms.has('ski_swap:admin');
  const [pendingTestPrint, setPendingTestPrint] = useState<SwapPrinterRecord | null>(null);
  const [isPrintingId, setIsPrintingId] = useState<string | null>(null);


  // ─── Printers state ───────────────────────────────────────────────────────
  const [printerName, setPrinterName] = useState('');
  const [printerBtName, setPrinterBtName] = useState('');
  const [printerPaperSize, setPrinterPaperSize] = useState<'40x30' | '50x30' | ''>('');
  // Holds the BluetoothDevice from the scan so the first print needs no picker
  const scannedDeviceRef = useRef<BluetoothDevice | null>(null);
  const [showPrinterForm, setShowPrinterForm] = useState(false);
  const [printerFormError, setPrinterFormError] = useState<string | null>(null);
  const [editingPrinter, setEditingPrinter] = useState<SwapPrinterRecord | null>(null);
  const [editPrinterName, setEditPrinterName] = useState('');
  const [editPrinterAssignedSellerId, setEditPrinterAssignedSellerId] = useState<string>('');
  const [editMargins, setEditMargins] = useState<PrinterMargins>(DEFAULT_PRINTER_MARGINS);

  const { data: printers = [] } = useQuery({
    queryKey: ['ski-swap/printers', orgId],
    queryFn: () => api.skiSwap.listPrinters(orgId),
    enabled: !!orgId && canManagePrinters,
  });

  const { data: sellers = [] } = useQuery<SellerResponse[]>({
    queryKey: ['ski-swap/sellers', orgId],
    queryFn: () => api.skiSwap.listSellers(orgId),
    enabled: !!orgId && canManagePrinters,
  });

  const createPrinterMutation = useMutation({
    mutationFn: () => api.skiSwap.createPrinter(orgId, { name: printerName, bluetoothName: printerBtName, paperSize: printerPaperSize }),
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

  async function handleCalibrationPrint(printer: SwapPrinterRecord) {
    if (!isWebBluetoothSupported()) { alert('Printing requires Chrome or Edge.'); return; }
    setIsPrintingId(`cal-${printer.id}`);
    try {
      await printCalibration(printer);
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'NotFoundError')
        alert(`Print failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      setIsPrintingId(null);
    }
  }

  const patchPrinterMutation = useMutation({
    mutationFn: (data: { name?: string; assignedSellerId?: string | null; paperSize?: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number }) =>
      api.skiSwap.patchPrinter(orgId, editingPrinter!.id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] }); setEditingPrinter(null); },
  });

  /**
   * Binds a printer to a bridge. The foreign key lives on the printer, so moving
   * a bridge is a release followed by a bind — done here rather than server-side
   * because the server's job is to refuse a bridge that is already spoken for,
   * not to guess that the caller meant to move it.
   */
  const bindBridgeMutation = useMutation({
    mutationFn: async ({ bridgeId, printerId }: { bridgeId: string; printerId: string | null }) => {
      const current = printers.find((p: SwapPrinterRecord) => p.bridgeDeviceId === bridgeId);
      if (current && current.id !== printerId) {
        await api.skiSwap.patchPrinter(orgId, current.id, { bridgeDeviceId: null });
      }
      if (printerId) await api.skiSwap.patchPrinter(orgId, printerId, { bridgeDeviceId: bridgeId });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] }),
  });

  function BridgePrinterPicker(bridge: DeviceItem) {
    const bound = printers.find((p: SwapPrinterRecord) => p.bridgeDeviceId === bridge.id);
    return (
      <div className="mt-1.5">
        <label className="block text-xs text-gray-500 mb-1">Drives printer</label>
        <select
          value={bound?.id ?? ''}
          disabled={bindBridgeMutation.isPending}
          onChange={(e) => bindBridgeMutation.mutate({ bridgeId: bridge.id, printerId: e.target.value || null })}
          className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-xs text-white disabled:opacity-40"
        >
          <option value="">Not connected</option>
          {printers
            // A printer already driven by another bridge, or held by a seller,
            // is not one this bridge can take.
            .filter((p: SwapPrinterRecord) =>
              p.id === bound?.id || (!p.bridgeDeviceId && !p.assignedSellerId))
            .map((p: SwapPrinterRecord) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
        </select>
      </div>
    );
  }

  const deletePrinterMutation = useMutation({
    mutationFn: (id: string) => api.skiSwap.deletePrinter(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ski-swap/printers', orgId] }),
  });

  async function scanAnyPrinter() {
    if (!isWebBluetoothSupported()) { alert('Printing requires Chrome or Edge.'); return; }
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: ['0000ff00-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID] }],
        optionalServices: ['0000ff00-0000-1000-8000-00805f9b34fb' as BluetoothServiceUUID],
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
              onClick={() => { setShowPrinterForm(true); setPrinterName(''); setPrinterBtName(''); setPrinterPaperSize(''); setPrinterFormError(null); }}
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
              <select
                value={printerPaperSize}
                onChange={(e) => setPrinterPaperSize(e.target.value as '40x30' | '50x30')}
                required
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              >
                <option value="" disabled>Paper size (required)</option>
                <option value="40x30">40 × 30 mm</option>
                <option value="50x30">50 × 30 mm</option>
              </select>
              {printerFormError && <p className="text-red-400 text-xs">{printerFormError}</p>}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => { setShowPrinterForm(false); scannedDeviceRef.current = null; setPrinterFormError(null); }} className="text-sm text-gray-400 hover:text-white px-3 py-2">Cancel</button>
                <button
                  type="submit"
                  disabled={createPrinterMutation.isPending || !printerName || !printerBtName || !printerPaperSize}
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
                  patchPrinterMutation.mutate({ name: editPrinterName, assignedSellerId: editPrinterAssignedSellerId || null, ...editMargins });
                }}
              >
                <h2 className="text-white font-semibold">Edit Printer</h2>
                <input
                  value={editPrinterName}
                  onChange={(e) => setEditPrinterName(e.target.value)}
                  required
                  className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                />
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Assign to seller (leave blank for org pool)</label>
                  <select
                    value={editPrinterAssignedSellerId}
                    onChange={(e) => setEditPrinterAssignedSellerId(e.target.value)}
                    className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                  >
                    <option value="">Org pool (unassigned)</option>
                    {sellers.filter((s) => s.businessName !== null).map((s) => (
                      <option key={s.id} value={s.id}>{s.displayName}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-gray-400 block mb-1">Paper size</label>
                  <select
                    value={editingPrinter.paperSize}
                    onChange={(e) => patchPrinterMutation.mutate({ paperSize: e.target.value as '40x30' | '50x30' })}
                    className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                  >
                    <option value="40x30">40 × 30 mm</option>
                    <option value="50x30">50 × 30 mm</option>
                  </select>
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
                    {p.assignedSellerName ? `Assigned to: ${p.assignedSellerName}` : 'Org pool'}{' · '}{p.paperSize === '40x30' ? '40×30 mm' : '50×30 mm'}
                  </p>
                  <p className="text-xs text-gray-600 font-mono mt-0.5">
                    T:{p.marginTop} B:{p.marginBottom} L:{p.marginLeft} R:{p.marginRight}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {p.bridgeName
                      ? <>Driven by <span className="text-gray-300">{p.bridgeName}</span>{p.stationName ? ` for ${p.stationName}` : ' — no station yet'}</>
                      : 'No bridge — prints over Bluetooth'}
                  </p>
                </div>
                <div className="flex gap-2 items-center">
                  <button
                    onClick={() => handleCalibrationPrint(p)}
                    disabled={!!isPrintingId}
                    className="text-xs text-gray-500 hover:text-white flex items-center gap-1 disabled:opacity-40"
                    title="Print calibration pattern"
                  >
                    Calibrate
                  </button>
                  <button
                    onClick={() => handleTestPrint(p)}
                    disabled={!!isPrintingId}
                    className="text-xs text-gray-400 hover:text-white flex items-center gap-1 disabled:opacity-40"
                    title="Print identification label"
                  >
                    <FontAwesomeIcon icon={faPrintDuo} />{isPrintingId === p.id ? ' Printing…' : ' Print label'}
                  </button>
                  <button
                    onClick={() => {
                      setEditingPrinter(p); setEditPrinterName(p.name);
                      setEditPrinterAssignedSellerId(p.assignedSellerId ?? '');
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
            A bridge puts one printer on the network so a check-in station can print to it.
            Bind the bridge to its printer here, then bind the bridge to a station on the
            Check-in stations page.
          </p>
        </div>
        <MutationError error={bindBridgeMutation.error} />
        <DeviceCredentialList
          orgId={orgId}
          roles={BRIDGE_ROLES}
          printers={printers}
          canProvision={canManagePrinters}
          renderExtra={BridgePrinterPicker}
        />
      </div>

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
                className="flex-1 bg-brand-600 hover:bg-brand-700 text-white text-sm rounded py-1.5 flex items-center justify-center gap-1"
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
