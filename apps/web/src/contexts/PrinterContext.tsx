import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  connectFromPool,
  connectPrinter,
  DEFAULT_PRINTER_MARGINS,
  generateLabel,
  generatePrinterLabel,
  generateQrLabel,
  generateReceiptHeaderLabel,
  generateReceiptItemLabels,
  generateCalibrationPattern,
  isWebBluetoothSupported,
  previewLabel,
  previewPrinterLabel,
  previewQrLabel,
  previewReceiptHeaderLabel,
  previewReceiptItemLabels,
  previewCalibrationPattern,
  reconnectPrinter,
} from '../lib/printing/PhomemoPrinterService';
import type { ConnectedM110, PaperSize, PrinterMargins } from '../lib/printing/PhomemoPrinterService';
import type { ItemResponse, SellerResponse, SwapPrinterRecord } from '../lib/api.types';
import { SELLER_SITE_URL } from '../lib/sellerSiteUrl';

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
  printQrLabel(sellerName: string, url: string): Promise<void>;
  printPrinterIdLabel(printer: SwapPrinterRecord, orgName: string): Promise<void>;
  printCalibration(printer: SwapPrinterRecord): Promise<void>;
  printReceipt(seller: SellerResponse, items: { name: string; sku: string; priceCents: number }[], orgLogoUrl: string | null): Promise<void>;
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

function marginsFromRecord(p: SwapPrinterRecord): PrinterMargins {
  return { marginTop: p.marginTop, marginBottom: p.marginBottom, marginLeft: p.marginLeft, marginRight: p.marginRight };
}

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

    const margins: PrinterMargins = pref
      ? { marginTop: pref.marginTop, marginBottom: pref.marginBottom, marginLeft: pref.marginLeft, marginRight: pref.marginRight }
      : DEFAULT_PRINTER_MARGINS;
    const paperSize = (pref?.paperSize ?? '40x30') as PaperSize;

    if (previewMode) {
      setPendingPreview(previewLabel({ name: item.name, priceCents: item.priceCents, sku: item.sku }, paperSize, margins));
      return;
    }

    const rows = generateLabel({ name: item.name, priceCents: item.priceCents, sku: item.sku }, paperSize, margins);
    await conn.print(rows);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectPrinterById]);

  const printQrLabel = useCallback(async (sellerName: string, url: string): Promise<void> => {
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
    const margins = pref ? marginsFromRecord(pref) : DEFAULT_PRINTER_MARGINS;
    const paperSize = (pref?.paperSize ?? '40x30') as PaperSize;
    if (previewMode) {
      setPendingPreview(await previewQrLabel(sellerName, url, paperSize, margins));
      return;
    }
    await conn.print(await generateQrLabel(sellerName, url, paperSize, margins));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectPrinterById]);

  const printPrinterIdLabel = useCallback(async (printer: SwapPrinterRecord, orgName: string): Promise<void> => {
    const ps      = (printer.paperSize ?? '40x30') as PaperSize;
    const margins = marginsFromRecord(printer);
    if (previewMode) {
      setPendingPreview(previewPrinterLabel(printer.name, orgName, ps, margins));
      return;
    }
    const conn = connectionsRef.current.get(printer.id) ?? await connectPrinterById(printer);
    await conn.print(generatePrinterLabel(printer.name, orgName, ps, margins));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectPrinterById]);

  const printCalibration = useCallback(async (printer: SwapPrinterRecord): Promise<void> => {
    const ps      = (printer.paperSize ?? '40x30') as PaperSize;
    const margins = marginsFromRecord(printer);
    if (previewMode) {
      setPendingPreview(previewCalibrationPattern(ps, margins));
      return;
    }
    const conn = connectionsRef.current.get(printer.id) ?? await connectPrinterById(printer);
    await conn.print(generateCalibrationPattern(ps, margins));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectPrinterById]);

  const printReceipt = useCallback(async (
    seller: SellerResponse,
    items: { name: string; sku: string; priceCents: number }[],
    orgLogoUrl: string | null,
  ): Promise<void> => {
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

    const margins = pref ? marginsFromRecord(pref) : DEFAULT_PRINTER_MARGINS;
    const paperSize = (pref?.paperSize ?? '40x30') as PaperSize;
    const date = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const qrUrl = `${SELLER_SITE_URL}/s/${seller.id}`;

    if (previewMode) {
      const headerUrl = await previewReceiptHeaderLabel(orgLogoUrl, date, seller.name, seller.phone, qrUrl, paperSize, margins);
      const pageUrls = previewReceiptItemLabels(items, paperSize, margins);
      setPendingPreviews([headerUrl, ...pageUrls]);
      return;
    }

    await conn.print(await generateReceiptHeaderLabel(orgLogoUrl, date, seller.name, seller.phone, qrUrl, paperSize, margins));
    for (const page of generateReceiptItemLabels(items, paperSize, margins)) {
      await conn.print(page);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectPrinterById]);

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
