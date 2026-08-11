import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  connectFromPool,
  connectPrinter,
  generateLabel,
  isWebBluetoothSupported,
  reconnectPrinter,
} from '../lib/printing/PhomemoPrinterService';
import type { ConnectedM110 } from '../lib/printing/PhomemoPrinterService';
import type { ItemResponse, SwapPrinterRecord } from '../lib/api.types';

interface PrinterContextValue {
  printers: SwapPrinterRecord[];
  connections: Map<string, ConnectedM110>;
  preferredPrinter: SwapPrinterRecord | null;
  isPreferredConnected: boolean;
  setPreferredPrinter(printer: SwapPrinterRecord | null): void;
  connectPreferred(): Promise<void>;
  disconnectPreferred(): void;
  connectPrinterById(printer: SwapPrinterRecord): Promise<ConnectedM110>;
  registerConnection(printer: SwapPrinterRecord, conn: ConnectedM110): void;
  printItem(item: ItemResponse): Promise<void>;
  isSupported: boolean;
}

const PrinterContext = createContext<PrinterContextValue | null>(null);

export function usePrinter(): PrinterContextValue {
  const ctx = useContext(PrinterContext);
  if (!ctx) throw new Error('usePrinter must be used inside PrinterProvider');
  return ctx;
}

interface Props {
  orgId: string;
  userId: string;
  isSeller: boolean;
  canPrint: boolean;
  children: React.ReactNode;
}

export function PrinterProvider({ orgId, userId, isSeller, canPrint, children }: Props) {
  const isSupported = isWebBluetoothSupported();
  const storageKey = `patrolkit:${userId}:${orgId}:preferredPrinter`;

  const [connections, setConnections] = useState<Map<string, ConnectedM110>>(new Map());
  const connectionsRef = useRef<Map<string, ConnectedM110>>(new Map());

  const [preferredPrinterId, _setPreferredPrinterId] = useState<string | null>(
    () => localStorage.getItem(storageKey),
  );
  const preferredPrinterIdRef = useRef(preferredPrinterId);
  const printersRef = useRef<SwapPrinterRecord[]>([]);

  const { data: printers = [] } = useQuery({
    queryKey: isSeller ? ['ski-swap/seller-printers', orgId] : ['ski-swap/printers', orgId],
    queryFn: () => (isSeller ? api.skiSwap.sellerListPrinters(orgId) : api.skiSwap.listPrinters(orgId)),
    enabled: !!orgId && isSupported && canPrint,
    staleTime: 60_000,
  });
  printersRef.current = printers;

  function persistPreferred(id: string | null) {
    _setPreferredPrinterId(id);
    preferredPrinterIdRef.current = id;
    if (id) localStorage.setItem(storageKey, id);
    else localStorage.removeItem(storageKey);
  }

  function updateConnections(updater: (prev: Map<string, ConnectedM110>) => Map<string, ConnectedM110>) {
    setConnections((prev) => {
      const next = updater(prev);
      connectionsRef.current = next;
      return next;
    });
  }

  function attachDisconnectHandler(printerId: string, conn: ConnectedM110) {
    conn.device.addEventListener('gattserverdisconnected', () => {
      updateConnections((prev) => { const m = new Map(prev); m.delete(printerId); return m; });
    });
  }

  // Auto-select preferred + stale-preference cleanup
  useEffect(() => {
    if (printers.length === 0) return;
    const prefId = preferredPrinterIdRef.current;
    const inPool = prefId && printers.some((p) => p.id === prefId);

    if (prefId && !inPool) {
      persistPreferred(printers.length === 1 ? printers[0].id : null);
    } else if (!prefId && printers.length === 1) {
      persistPreferred(printers[0].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers]);

  // Silent reconnect to preferred printer on mount
  useEffect(() => {
    if (!isSupported) return;
    const timer = setTimeout(async () => {
      const prefId = preferredPrinterIdRef.current;
      if (!prefId) return;
      const printer = printersRef.current.find((p) => p.id === prefId);
      if (!printer) return;
      const conn = await reconnectPrinter(printer.bluetoothName);
      if (conn) {
        updateConnections((prev) => new Map(prev).set(printer.id, conn));
        attachDisconnectHandler(printer.id, conn);
      }
    }, 500);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported]);

  const registerConnection = useCallback((printer: SwapPrinterRecord, conn: ConnectedM110) => {
    updateConnections((prev) => new Map(prev).set(printer.id, conn));
    attachDisconnectHandler(printer.id, conn);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectPrinterById = useCallback(async (printer: SwapPrinterRecord): Promise<ConnectedM110> => {
    const conn = (await reconnectPrinter(printer.bluetoothName)) ?? await connectPrinter(printer.bluetoothName);
    updateConnections((prev) => new Map(prev).set(printer.id, conn));
    attachDisconnectHandler(printer.id, conn);
    persistPreferred(printer.id);
    return conn;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const connectPreferred = useCallback(async (): Promise<void> => {
    if (!isSupported) return;
    const pool = printersRef.current;
    const pref = pool.find((p) => p.id === preferredPrinterIdRef.current);

    if (pref) {
      await connectPrinterById(pref);
    } else {
      const conn = await connectFromPool(pool.map((p) => p.bluetoothName));
      const matched = printersRef.current.find((p) => p.bluetoothName === conn.bluetoothName);
      if (matched) {
        updateConnections((prev) => new Map(prev).set(matched.id, conn));
        attachDisconnectHandler(matched.id, conn);
        persistPreferred(matched.id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSupported, connectPrinterById]);

  const disconnectPreferred = useCallback((): void => {
    const prefId = preferredPrinterIdRef.current;
    if (!prefId) return;
    connectionsRef.current.get(prefId)?.disconnect();
    updateConnections((prev) => { const m = new Map(prev); m.delete(prefId); return m; });
  }, []);

  function setPreferredPrinter(printer: SwapPrinterRecord | null) {
    persistPreferred(printer?.id ?? null);
  }

  const printItem = useCallback(async (item: ItemResponse): Promise<void> => {
    const pool = printersRef.current;
    const pref = pool.find((p) => p.id === preferredPrinterIdRef.current);
    let conn = pref ? connectionsRef.current.get(pref.id) : undefined;

    if (!conn) {
      if (pref) {
        conn = await connectPrinterById(pref);
      } else {
        const poolConn = await connectFromPool(pool.map((p) => p.bluetoothName));
        const matched = printersRef.current.find((p) => p.bluetoothName === poolConn.bluetoothName);
        if (matched) {
          updateConnections((prev) => new Map(prev).set(matched.id, poolConn));
          attachDisconnectHandler(matched.id, poolConn);
          persistPreferred(matched.id);
          conn = poolConn;
        }
      }
    }

    if (!conn) throw new Error('No printer connected');
    const rows = generateLabel({ name: item.name, priceCents: item.priceCents, sku: item.sku });
    await conn.print(rows);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectPrinterById]);

  const preferredPrinter = printers.find((p) => p.id === preferredPrinterId) ?? null;
  const isPreferredConnected = preferredPrinter ? connections.has(preferredPrinter.id) : false;

  return (
    <PrinterContext.Provider value={{
      printers, connections, preferredPrinter, isPreferredConnected,
      setPreferredPrinter, connectPreferred, disconnectPreferred,
      connectPrinterById, registerConnection, printItem, isSupported,
    }}>
      {children}
    </PrinterContext.Provider>
  );
}
