import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { isWebBluetoothSupported } from '../lib/printing/PhomemoPrinterService';
import { listenForScans, pickScannerNamed, type Scan } from '../lib/printing/InateckScannerService';
import type { SwapScanner } from '../lib/api.types';

/**
 * A scanner connected to this browser (Plan 40 D1, D2), the way a printer is:
 * one of the org's scanners, chosen per browser and remembered, connected from
 * the nav bar, and kept connected across pages. A screen that wants scans
 * subscribes while it's open; with nobody listening, a scan only updates
 * `lastScan`, which the nav bar shows as a test.
 */
interface ScannerContextValue {
  isSupported: boolean;
  /** The org's scanners a browser can reach: none held by a bridge. */
  scanners: SwapScanner[];
  preferred: SwapScanner | null;
  connected: boolean;
  connecting: boolean;
  lastScan: { text: string; at: number } | null;
  /** Connects to this scanner, or the chosen one, showing the picker if the browser needs it. */
  connect(scanner?: SwapScanner): Promise<void>;
  disconnect(): void;
  /** Hands each scan to `onScan` until the returned function is called. */
  subscribe(onScan: (scan: Scan) => void): () => void;
}

const ScannerContext = createContext<ScannerContextValue | null>(null);

export function useScanner(): ScannerContextValue {
  const ctx = useContext(ScannerContext);
  if (!ctx) throw new Error('useScanner must be used inside ScannerProvider');
  return ctx;
}

/** A device this browser was already allowed, found without the picker. */
async function knownDevice(bluetoothName: string): Promise<BluetoothDevice | null> {
  if (!('getDevices' in navigator.bluetooth)) return null;
  try {
    const devices = await (navigator.bluetooth as unknown as { getDevices(): Promise<BluetoothDevice[]> }).getDevices();
    return devices.find((d) => d.name === bluetoothName) ?? null;
  } catch {
    return null;
  }
}

export function ScannerProvider({ orgId, userId, enabled, children }: {
  orgId: string;
  userId: string;
  /** Staff who can add items: the only ones with a use for a scanner here. */
  enabled: boolean;
  children: React.ReactNode;
}) {
  const isSupported = isWebBluetoothSupported();
  const storageKey = `patrolkit:${userId}:${orgId}:preferredScanner`;
  const { data: all = [] } = useQuery({
    queryKey: ['ski-swap/scanners', orgId],
    queryFn: () => api.skiSwap.listScanners(orgId),
    enabled: !!orgId && isSupported && enabled,
    staleTime: 60_000,
  });
  const scanners = all.filter((s) => !s.bridgeDeviceId);

  const [preferredId, setPreferredId] = useState<string | null>(() => {
    try { return localStorage.getItem(storageKey); } catch { return null; }
  });
  const remember = (id: string | null) => {
    setPreferredId(id);
    try {
      if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey);
    } catch { /* private window: chosen for this visit only */ }
  };
  // One scanner the org has, and none chosen: that's the one.
  const preferred = scanners.find((s) => s.id === preferredId) ?? (scanners.length === 1 ? scanners[0] : null);

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [lastScan, setLastScan] = useState<{ text: string; at: number } | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const listeners = useRef(new Set<(scan: Scan) => void>());

  const onScan = useCallback((scan: Scan) => {
    setLastScan({ text: scan.payload, at: Date.now() });
    for (const fn of listeners.current) fn(scan);
  }, []);

  const attach = useCallback(async (device: BluetoothDevice) => {
    stopRef.current?.();
    stopRef.current = await listenForScans(device, onScan, () => {
      stopRef.current = null;
      setConnected(false);
    });
    setConnected(true);
  }, [onScan]);

  const connect = useCallback(async (scanner?: SwapScanner) => {
    const target = scanner ?? preferred;
    if (!target) throw new Error('No scanner is set up for this organization. Add one on the Hardware page.');
    setConnecting(true);
    try {
      const device = (await knownDevice(target.bluetoothName)) ?? await pickScannerNamed(target.bluetoothName);
      await attach(device);
      remember(target.id);
    } finally {
      setConnecting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferred, attach]);

  const disconnect = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setConnected(false);
  }, []);

  const subscribe = useCallback((fn: (scan: Scan) => void) => {
    listeners.current.add(fn);
    return () => { listeners.current.delete(fn); };
  }, []);

  // Reconnects the chosen scanner without the picker, where the browser allows.
  const tried = useRef(false);
  useEffect(() => {
    if (!isSupported || !enabled || !preferred || tried.current) return;
    tried.current = true;
    void (async () => {
      const device = await knownDevice(preferred.bluetoothName);
      if (device) await attach(device).catch(() => setConnected(false));
    })();
  }, [isSupported, enabled, preferred, attach]);

  useEffect(() => () => stopRef.current?.(), []);

  return (
    <ScannerContext.Provider value={{
      isSupported, scanners, preferred, connected, connecting, lastScan, connect, disconnect, subscribe,
    }}>
      {children}
    </ScannerContext.Provider>
  );
}
