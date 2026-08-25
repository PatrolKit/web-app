import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { usePrinter } from '../../contexts/PrinterContext';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

interface Props {
  seller: SellerResponse | null;
  swapId: string | null;
  onClose: () => void;
}

export default function PrintReceiptModal({ seller, swapId, onClose }: Props) {
  const { orgId } = useOutletContext<SkiSwapContext>();
  const { printReceipt } = usePrinter();
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);

  const enabled = !!seller && !!swapId;

  const { data: itemsData, isLoading: itemsLoading, error: itemsError } = useQuery({
    queryKey: ['ski-swap/items', orgId, swapId, seller?.id],
    queryFn: () => api.skiSwap.listItems(orgId, swapId!, { sellerId: seller!.id }),
    enabled,
    staleTime: 30_000,
  });
  const items = itemsData?.items ?? [];

  const { data: org, isLoading: orgLoading } = useQuery({
    queryKey: ['orgs', orgId],
    queryFn: () => api.orgs.get(orgId),
    enabled,
    staleTime: 300_000,
  });

  if (!seller) return null;

  const isLoading = itemsLoading;
  const totalCents = items.reduce((sum, it) => sum + it.priceCents * it.inStock, 0);

  async function handlePrint() {
    setPrinting(true);
    setPrintError(null);
    try {
      const logoUrl = org?.logoUrl ? `/api/v1/orgs/${orgId}/logo` : null;
      await printReceipt(seller!, items, logoUrl);
      onClose();
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
          <h3 className="text-white font-medium">Print Receipt</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">×</button>
        </div>

        <div>
          <p className="text-white text-sm font-medium">{seller.displayName}</p>
          {!swapId ? (
            <p className="text-yellow-400 text-xs mt-1">No swap selected — select a swap first</p>
          ) : isLoading ? (
            <p className="text-gray-400 text-xs mt-1">Loading…</p>
          ) : itemsError ? (
            <p className="text-red-400 text-xs mt-1">Failed to load items</p>
          ) : (
            <div className="mt-1 space-y-0.5">
              <p className="text-gray-400 text-xs">{items.length} item{items.length !== 1 ? 's' : ''}</p>
              <p className="text-gray-400 text-xs">Total value: ${(totalCents / 100).toFixed(2)}</p>
            </div>
          )}
        </div>

        <button
          onClick={handlePrint}
          disabled={printing || isLoading || !swapId}
          className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white py-2 rounded text-sm font-medium"
        >
          {printing ? 'Printing…' : 'Print Receipt'}
        </button>

        {printError && (
          <div className="space-y-1">
            <p className="text-red-400 text-xs text-center">{printError}</p>
            <button onClick={handlePrint} disabled={printing}
              className="w-full text-xs text-gray-400 hover:text-white py-1 disabled:opacity-40">
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
