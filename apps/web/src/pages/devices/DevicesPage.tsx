import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import QRCode from 'react-qr-code';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBluetooth, faPrint as faPrintDuo } from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';
import { connectFromDevice, DEFAULT_PRINTER_MARGINS, isWebBluetoothSupported } from '../../lib/printing/PhomemoPrinterService';
import type { PrinterMargins } from '../../lib/printing/PhomemoPrinterService';
import { usePrinter } from '../../contexts/PrinterContext';
import type { DeviceItem, SellerResponse, SwapPrinterRecord } from '../../lib/api.types';

import type { DeviceRole } from '../../lib/api.types';

type Tab = 'tablets' | 'printers';

const tabClass = (active: boolean) =>
  `text-sm px-3 py-1.5 rounded transition ${active ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

function ProvisioningCodeCard({ clientId, secret, onDismiss }: { clientId: string; secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const payload = JSON.stringify({
    v: 1, cid: clientId, sec: secret,
    api: `${window.location.protocol}//${window.location.host}/api/v1`,
  });

  const copy = () => {
    const el = document.createElement('textarea');
    el.value = payload;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.focus();
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    navigator.clipboard?.writeText(payload).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-green-900/30 border border-green-700 rounded-lg p-4">
      <p className="text-green-400 font-medium mb-4">Device provisioned — scan or copy the code now</p>
      <div className="flex flex-col items-center gap-3">
        <div className="bg-white p-3 rounded">
          <QRCode value={payload} size={200} />
        </div>
        <p className="text-xs text-gray-400">Scan with PatrolKit iOS, or copy below</p>
        <button
          onClick={copy}
          className="text-sm bg-brand-500 hover:bg-brand-600 text-white px-6 py-2 rounded w-full max-w-xs transition-colors"
        >
          {copied ? 'Copied!' : 'Copy provisioning code'}
        </button>
      </div>
      <button onClick={onDismiss} className="mt-4 text-xs text-gray-500 hover:underline block">Dismiss</button>
    </div>
  );
}

export default function DevicesPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const { registerConnection, printPrinterIdLabel, printCalibration } = usePrinter();
  const canManagePrinters = perms.has('ski_swap:admin');
  const [activeTab, setActiveTab] = useState<Tab>('tablets');
  const [pendingTestPrint, setPendingTestPrint] = useState<SwapPrinterRecord | null>(null);
  const [isPrintingId, setIsPrintingId] = useState<string | null>(null);

  // ─── Tablets state ────────────────────────────────────────────────────────
  const [provisionName, setProvisionName] = useState('');
  const [provisionRole, setProvisionRole] = useState<DeviceRole>('Ski Swap - Check-In');
  const [showProvisionForm, setShowProvisionForm] = useState(false);
  const [editingRole, setEditingRole] = useState<{
    id: string;
    value: DeviceRole;
  } | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{
    id: string;
    clientId: string;
    secret: string;
  } | null>(null);

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ['devices', orgId],
    queryFn: () => api.devices.list(orgId),
    enabled: !!orgId,
  });

  const provisionMutation = useMutation({
    mutationFn: () =>
      api.devices.provision(orgId, { name: provisionName, role: provisionRole, permissions: [] }),
    onSuccess: (d) => {
      setRevealedSecret({ id: d.id, clientId: d.clientId, secret: d.clientSecret });
      setProvisionName('');
      setProvisionRole('Ski Swap - Check-In');
      setShowProvisionForm(false);
      qc.invalidateQueries({ queryKey: ['devices', orgId] });
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => api.devices.rotateSecret(orgId, id),
    onSuccess: (d, id) => {
      const device = devices.find((dev) => dev.id === id);
      setRevealedSecret({ id, clientId: device?.clientId ?? '', secret: d.clientSecret });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.devices.revoke(orgId, id),
    onSettled: () => qc.invalidateQueries({ queryKey: ['devices', orgId] }),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: DeviceRole }) =>
      api.devices.updateRole(orgId, id, role),
    onSuccess: (updated) => {
      qc.setQueryData<DeviceItem[]>(['devices', orgId], (prev) =>
        prev?.map((d) => (d.id === updated.id ? updated : d)),
      );
      setEditingRole(null);
    },
  });

  // ─── Printers state ───────────────────────────────────────────────────────
  const [printerName, setPrinterName] = useState('');
  const [printerBtName, setPrinterBtName] = useState('');
  const [printerPaperSize, setPrinterPaperSize] = useState<'40x30' | '50x30' | ''>('');
  // Holds the BluetoothDevice from the scan so the first print needs no picker
  const scannedDeviceRef = useRef<BluetoothDevice | null>(null);
  const [showPrinterForm, setShowPrinterForm] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
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
      setProvisionError(null);
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
    onError: (err: Error) => setProvisionError(err.message),
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

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Devices</h1>

      {/* Tab bar */}
      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <button className={tabClass(activeTab === 'tablets')} onClick={() => setActiveTab('tablets')}>
          Tablets
        </button>
        {canManagePrinters && (
          <button className={tabClass(activeTab === 'printers')} onClick={() => setActiveTab('printers')}>
            Printers
          </button>
        )}
      </nav>

      {/* ── Tablets tab ──────────────────────────────────────────────────── */}
      {activeTab === 'tablets' && (
        <div className="space-y-4">
          {perms.has('devices:provision') && (
            <div className="flex justify-end">
              <button
                onClick={() => { setShowProvisionForm(true); setProvisionName(''); setProvisionRole('Ski Swap - Check-In'); }}
                className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
              >
                + Provision Device
              </button>
            </div>
          )}

          {showProvisionForm && perms.has('devices:provision') && (
            <form
              onSubmit={(e) => { e.preventDefault(); provisionMutation.mutate(); }}
              className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
            >
              <h3 className="text-white font-medium">New Device</h3>
              <input
                value={provisionName}
                onChange={(e) => setProvisionName(e.target.value)}
                placeholder="Device name"
                required
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              />
              <select
                value={provisionRole}
                onChange={(e) => setProvisionRole(e.target.value as typeof provisionRole)}
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
              >
                <option value="Ski Swap - Check-In">Ski Swap - Check-In</option>
                <option value="Ski Swap - Bulk Seller">Ski Swap - Bulk Seller</option>
                <option value="Time Clock">Time Clock</option>
              </select>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setShowProvisionForm(false)} className="text-sm text-gray-400 hover:text-white px-3 py-2">Cancel</button>
                <button
                  type="submit"
                  disabled={provisionMutation.isPending}
                  className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm"
                >
                  {provisionMutation.isPending ? 'Provisioning…' : 'Provision'}
                </button>
              </div>
            </form>
          )}

          {revealedSecret && (
            <ProvisioningCodeCard
              clientId={revealedSecret.clientId}
              secret={revealedSecret.secret}
              onDismiss={() => setRevealedSecret(null)}
            />
          )}

          <div className="space-y-3">
            {devices.map((d: DeviceItem) => (
              <div key={d.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
                <div>
                  <span className="font-medium text-white">{d.name}</span>
                  <p className="text-xs text-gray-500 mt-0.5">Client ID: {d.clientId}</p>
                  {d.lastSeenAt && <p className="text-xs text-gray-500">Last seen: {new Date(d.lastSeenAt).toLocaleString()}</p>}
                  {editingRole?.id === d.id ? (
                    <div className="flex items-center gap-1 mt-1">
                      <select
                        autoFocus
                        value={editingRole.value}
                        onChange={(e) => setEditingRole({ id: d.id, value: e.target.value as typeof editingRole.value })}
                        className="text-xs bg-surface-100 border border-gray-600 rounded px-2 py-0.5 text-white"
                      >
                        <option value="Ski Swap - Check-In">Ski Swap - Check-In</option>
                        <option value="Ski Swap - Bulk Seller">Ski Swap - Bulk Seller</option>
                        <option value="Time Clock">Time Clock</option>
                <option value="Time Clock">Time Clock</option>
                      </select>
                      <button onClick={() => updateRoleMutation.mutate({ id: d.id, role: editingRole.value })} disabled={updateRoleMutation.isPending} className="text-xs text-green-400 hover:underline">Save</button>
                      <button onClick={() => setEditingRole(null)} className="text-xs text-gray-500 hover:underline">Cancel</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 mt-1">
                      <span className="text-xs text-gray-400">{d.role}</span>
                      {perms.has('devices:provision') && (
                        <button onClick={() => setEditingRole({ id: d.id, value: d.role })} className="text-xs text-gray-600 hover:text-gray-400" aria-label="Edit role">✎</button>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  {perms.has('devices:provision') && (
                    <button onClick={() => rotateMutation.mutate(d.id)} className="text-xs text-yellow-500 hover:underline">Rotate</button>
                  )}
                  {perms.has('devices:revoke') && (
                    <button
                      onClick={() => { if (window.confirm(`Revoke "${d.name}"? This will permanently remove the device and it will need to be re-provisioned.`)) revokeMutation.mutate(d.id); }}
                      className="text-xs text-red-500 hover:underline"
                    >Revoke</button>
                  )}
                </div>
              </div>
            ))}
            {devices.length === 0 && <p className="text-gray-500 text-sm">No devices provisioned yet.</p>}
          </div>
        </div>
      )}

      {/* ── Printers tab ─────────────────────────────────────────────────── */}
      {activeTab === 'printers' && canManagePrinters && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              onClick={() => { setShowPrinterForm(true); setPrinterName(''); setPrinterBtName(''); setPrinterPaperSize(''); setProvisionError(null); }}
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
              {provisionError && <p className="text-red-400 text-xs">{provisionError}</p>}
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => { setShowPrinterForm(false); scannedDeviceRef.current = null; setProvisionError(null); }} className="text-sm text-gray-400 hover:text-white px-3 py-2">Cancel</button>
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
