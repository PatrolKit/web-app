import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  connectFromPool,
  connectPrinter,
  isWebBluetoothSupported,
  reconnectPrinter,
} from '../lib/printing/PhomemoPrinterService';
import type { ConnectedM110, PaperSize } from '../lib/printing/PhomemoPrinterService';
import type { ItemResponse, SwapPrinterRecord } from '../lib/api.types';

interface PrinterContextValue {
  printers: SwapPrinterRecord[];
  connections: Map<string, ConnectedM110>;
  preferredPrinter: SwapPrinterRecord | null;
  isPreferredConnected: boolean;
  setPreferredPrinter(printer: SwapPrinterRecord | null): void;
  setPaperSize(paperSize: PaperSize): Promise<void>;
  connectPreferred(): Promise<void>;
  disconnectPreferred(): void;
  connectPrinterById(printer: SwapPrinterRecord): Promise<ConnectedM110>;
  registerConnection(printer: SwapPrinterRecord, conn: ConnectedM110): void;
  printItem(item: ItemResponse): Promise<void>;
  printQrLabel(sellerId: string): Promise<void>;
  printPrinterIdLabel(printer: SwapPrinterRecord): Promise<void>;
  printCalibration(printer: SwapPrinterRecord): Promise<void>;
  printReceipt(sellerId: string, swapId: string): Promise<void>;
  previewMode: boolean;
  pendingPreview: string | null;
  pendingPreviews: string[];
  setPreviewMode(on: boolean): void;
  clearPendingPreview(): void;
  setPendingPreview(dataUrl: string): void;
  setPendingPreviews(pages: string[]): void;
  clearPendingPreviews(): void;
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
  const previewStorageKey = `patrolkit:preferredPreview`; // global flag, not per-org
  const queryClient = useQueryClient();
  const printerQueryKey = isSeller ? ['ski-swap/seller-printers', orgId] : ['ski-swap/printers', orgId];

  const [previewMode, setPreviewModeState] = useState(() => localStorage.getItem(previewStorageKey) === '1');
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);
  const [pendingPreviews, setPendingPreviews] = useState<string[]>([]);

  function setPreviewMode(on: boolean) {
    setPreviewModeState(on);
    if (on) localStorage.setItem(previewStorageKey, '1');
    else localStorage.removeItem(previewStorageKey);
  }
  const clearPendingPreview = useCallback(() => setPendingPreview(null), []);
  const clearPendingPreviews = useCallback(() => setPendingPreviews([]), []);

  const [connections, setConnections] = useState<Map<string, ConnectedM110>>(new Map());
  const connectionsRef = useRef<Map<string, ConnectedM110>>(new Map());

  const [preferredPrinterId, _setPreferredPrinterId] = useState<string | null>(
    () => localStorage.getItem(storageKey),
  );
  const preferredPrinterIdRef = useRef(preferredPrinterId);
  const printersRef = useRef<SwapPrinterRecord[]>([]);

  const { data: printers = [] } = useQuery({
    queryKey: printerQueryKey,
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

  const setPaperSize = useCallback(async (paperSize: PaperSize): Promise<void> => {
    const prefId = preferredPrinterIdRef.current;
    if (!prefId) return;
    await api.skiSwap.patchPrinterPaperSize(orgId, prefId, paperSize);
    queryClient.invalidateQueries({ queryKey: printerQueryKey });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, printerQueryKey.join('|')]);

  /**
   * Resolves a printer to print on and a live connection to it, connecting or
   * showing the picker as needed. Every print path needs the same dance:
   * preferred printer if there is one, otherwise let the user pick from the
   * org's pool and remember what they chose.
   */
  const resolveTarget = useCallback(async (): Promise<{ printer: SwapPrinterRecord; conn: ConnectedM110 }> => {
    const pool = printersRef.current;
    const pref = pool.find((p) => p.id === preferredPrinterIdRef.current);

    if (pref) {
      const conn = connectionsRef.current.get(pref.id) ?? await connectPrinterById(pref);
      return { printer: pref, conn };
    }

    const poolConn = await connectFromPool(pool.map((p) => p.bluetoothName));
    const matched = printersRef.current.find((p) => p.bluetoothName === poolConn.bluetoothName);
    if (!matched) throw new Error('That printer is not registered to this organization');
    updateConnections((prev) => new Map(prev).set(matched.id, poolConn));
    attachDisconnectHandler(matched.id, poolConn);
    persistPreferred(matched.id);
    return { printer: matched, conn: poolConn };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectPrinterById]);

  /**
   * Asks the server to render, then either shows the result or writes it.
   *
   * Layout lives on the server, so preview mode is not a separate drawing path
   * — it is the same render returned as PNG. What you see is what the head
   * would have burned, because it came from the same rows.
   */
  const renderAndPrint = useCallback(async (
    printerId: string,
    conn: ConnectedM110 | null,
    body: Parameters<typeof api.skiSwap.renderLabel>[2],
  ): Promise<void> => {
    const { pages } = await api.skiSwap.renderLabel(orgId, printerId, {
      ...body,
      format: previewMode ? 'png' : 'escpos',
    });
    // Nothing to print, as for a receipt header on 62 × 100 stock, where the
    // receipt carries its own: neither preview it nor connect for it.
    if (pages.length === 0) return;

    if (previewMode) {
      const urls = pages.map((b64) => `data:image/png;base64,${b64}`);
      if (urls.length === 1) setPendingPreview(urls[0]);
      else setPendingPreviews(urls);
      return;
    }

    if (!conn) throw new Error('No printer connected');
    for (const page of pages) {
      await conn.write(Uint8Array.from(atob(page), (c) => c.charCodeAt(0)));
    }
  }, [orgId, previewMode]);

  const printItem = useCallback(async (item: ItemResponse): Promise<void> => {
    // Preview mode still needs a printer to render *against* — paper size and
    // margins are the printer's — but not a connection to it.
    if (previewMode) {
      const pref = printersRef.current.find((p) => p.id === preferredPrinterIdRef.current)
        ?? printersRef.current[0];
      if (!pref) throw new Error('No printer configured');
      return renderAndPrint(pref.id, null, { kind: 'item', itemId: item.id });
    }
    const { printer, conn } = await resolveTarget();
    await renderAndPrint(printer.id, conn, { kind: 'item', itemId: item.id });
  }, [previewMode, renderAndPrint, resolveTarget]);

  const printQrLabel = useCallback(async (sellerId: string): Promise<void> => {
    if (previewMode) {
      const pref = printersRef.current.find((p) => p.id === preferredPrinterIdRef.current)
        ?? printersRef.current[0];
      if (!pref) throw new Error('No printer configured');
      return renderAndPrint(pref.id, null, { kind: 'qr', sellerId });
    }
    const { printer, conn } = await resolveTarget();
    await renderAndPrint(printer.id, conn, { kind: 'qr', sellerId });
  }, [previewMode, renderAndPrint, resolveTarget]);

  const printPrinterIdLabel = useCallback(async (printer: SwapPrinterRecord): Promise<void> => {
    // Always this printer, never the preferred one: the label names the printer
    // it comes out of, which is the entire point of sticking it on the case.
    const conn = previewMode
      ? null
      : connectionsRef.current.get(printer.id) ?? await connectPrinterById(printer);
    await renderAndPrint(printer.id, conn, { kind: 'printer_label' });
  }, [previewMode, renderAndPrint, connectPrinterById]);

  const printCalibration = useCallback(async (printer: SwapPrinterRecord): Promise<void> => {
    const conn = previewMode
      ? null
      : connectionsRef.current.get(printer.id) ?? await connectPrinterById(printer);
    await renderAndPrint(printer.id, conn, { kind: 'calibration' });
  }, [previewMode, renderAndPrint, connectPrinterById]);

  const printReceipt = useCallback(async (sellerId: string, swapId: string): Promise<void> => {
    const target = previewMode
      ? { printer: printersRef.current.find((p) => p.id === preferredPrinterIdRef.current) ?? printersRef.current[0], conn: null }
      : await resolveTarget();
    if (!target.printer) throw new Error('No printer configured');

    // Header first, then the item pages. Two calls rather than one because the
    // header is a single label and the item list paginates; keeping them apart
    // means a long receipt does not re-render the header per page.
    await renderAndPrint(target.printer.id, target.conn, { kind: 'receipt_header', sellerId, swapId });
    await renderAndPrint(target.printer.id, target.conn, { kind: 'receipt_items', sellerId, swapId });
  }, [previewMode, renderAndPrint, resolveTarget]);

  const preferredPrinter = printers.find((p) => p.id === preferredPrinterId) ?? null;
  const isPreferredConnected = preferredPrinter ? connections.has(preferredPrinter.id) : false;

  return (
    <PrinterContext.Provider value={{
      printers, connections, preferredPrinter, isPreferredConnected,
      setPreferredPrinter, setPaperSize, connectPreferred, disconnectPreferred,
      connectPrinterById, registerConnection, printItem, printQrLabel, printPrinterIdLabel, printCalibration, printReceipt,
      previewMode, pendingPreview, pendingPreviews, setPreviewMode, clearPendingPreview, setPendingPreview, setPendingPreviews, clearPendingPreviews,
      isSupported,
    }}>
      {children}
    </PrinterContext.Provider>
  );
}
