import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { usePrinter } from '../../contexts/PrinterContext';
import { SELLER_SITE_URL } from '../../lib/sellerSiteUrl';
import type { SellerResponse } from '../../lib/api.types';

interface Props {
  seller: SellerResponse;
  onClose: () => void;
}

export default function SellerQrModal({ seller, onClose }: Props) {
  const { preferredPrinter, isPreferredConnected, printQrLabel } = usePrinter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  const sellerUrl = `${SELLER_SITE_URL}/s/${seller.id}`;

  useEffect(() => {
    if (!canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, sellerUrl, {
      width: 200,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    }).catch(console.error);
  }, [sellerUrl]);

  async function handlePrint() {
    setPrinting(true);
    setPrintError(null);
    try {
      await printQrLabel(seller.displayName, sellerUrl);
    } catch (err) {
      setPrintError(err instanceof Error ? err.message : 'Print failed');
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-xs w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">QR Code — {seller.displayName}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">×</button>
        </div>

        <div className="flex justify-center">
          <canvas ref={canvasRef} className="rounded bg-white p-2" />
        </div>

        <p className="text-gray-500 text-xs text-center break-all">{sellerUrl}</p>

        <button
          onClick={handlePrint}
          disabled={printing || (!isPreferredConnected && !preferredPrinter)}
          title={!preferredPrinter ? 'Connect a printer first' : undefined}
          className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white py-2 rounded text-sm font-medium"
        >
          {printing ? 'Printing…' : 'Print Label'}
        </button>

        {!preferredPrinter && (
          <p className="text-gray-500 text-xs text-center">Connect a printer first</p>
        )}

        {printError && <p className="text-red-400 text-xs text-center">{printError}</p>}
      </div>
    </div>
  );
}
