import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { usePrinter } from '../../contexts/PrinterContext';
import { useFeatures } from '../../lib/features';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';

interface Props {
  seller: SellerResponse | null;
  /** The swap to start on, when the seller has items in it; otherwise their newest active swap. */
  initialSwapId: string | null;
  onClose: () => void;
}

/**
 * A seller's receipt, for one of the active swaps they have items in. Which
 * swap is picked here: a seller can have items in more than one at once.
 */
export default function PrintReceiptModal({ seller, initialSwapId, onClose }: Props) {
  const { orgId } = useOutletContext<SkiSwapContext>();
  const swaps = seller?.receiptSwaps ?? [];
  const [swapId, setSwapId] = useState<string | null>(
    swaps.find((s) => s.id === initialSwapId)?.id ?? swaps[0]?.id ?? null,
  );
  const { sms } = useFeatures();
  const { printReceipt } = usePrinter();
  const [printing, setPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ destination: string; status: string } | null>(null);

  const enabled = !!seller && !!swapId;

  const { data: itemsData, isLoading: itemsLoading, error: itemsError } = useQuery({
    queryKey: ['ski-swap/items', orgId, swapId, seller?.id],
    queryFn: () => api.skiSwap.listItems(orgId, swapId!, { sellerId: seller!.id }),
    enabled,
    staleTime: 30_000,
  });
  const items = itemsData?.items ?? [];

  /**
   * What has already gone out, so a volunteer can see whether to send again.
   *
   * Read from the deliveries rather than from this session's state: somebody
   * else may have sent it, or the seller may have asked for it themselves.
   */
  const { data: receipts } = useQuery({
    queryKey: ['ski-swap/receipts', orgId, swapId, seller?.id],
    queryFn: () => api.receipts.list(orgId, seller!.id, swapId!),
    enabled,
    staleTime: 30_000,
  });
  const lastDelivery = receipts?.flatMap((r) => r.deliveries)[0] ?? null;

  if (!seller) return null;

  const isLoading = itemsLoading;
  // Priced items only; a ticket checked in before its price is counted apart (Plan 32).
  const totalCents = items.reduce((sum, it) => sum + (it.priceCents ?? 0) * it.inStock, 0);
  const unpricedCount = items.filter((it) => it.priceCents === null).length;

  async function handleSend() {
    setSending(true);
    setSendError(null);
    try {
      const res = await api.receipts.send(orgId, seller!.id, swapId!);
      setSent({ destination: res.destination, status: res.status });
    } catch (err) {
      // The "no verified contact" refusal is a sentence worth showing a
      // volunteer verbatim — it says what is missing.
      setSendError(err instanceof ApiError ? err.message : 'Could not send the receipt');
    } finally {
      setSending(false);
    }
  }

  async function handlePrint() {
    setPrinting(true);
    setPrintError(null);
    try {
      await printReceipt(seller!.id, swapId!);
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
          <h3 className="text-white font-medium">Receipt</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none">×</button>
        </div>

        <div>
          <p className="text-white text-sm font-medium">{seller.displayName}</p>
          {swaps.length > 1 && (
            <select
              value={swapId ?? ''}
              onChange={(e) => { setSwapId(e.target.value); setSent(null); setSendError(null); setPrintError(null); }}
              aria-label="Swap"
              className="mt-2 w-full bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            >
              {swaps.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          )}
          {swaps.length === 1 && <p className="text-gray-500 text-xs mt-0.5">{swaps[0].title}</p>}
          {!swapId ? (
            <p className="text-yellow-400 text-xs mt-1">This seller has no items in an active swap.</p>
          ) : isLoading ? (
            <p className="text-gray-400 text-xs mt-1">Loading…</p>
          ) : itemsError ? (
            <p className="text-red-400 text-xs mt-1">Failed to load items</p>
          ) : (
            <div className="mt-1 space-y-0.5">
              <p className="text-gray-400 text-xs">{items.length} item{items.length !== 1 ? 's' : ''}</p>
              <p className="text-gray-400 text-xs">
                Total value: ${(totalCents / 100).toFixed(2)}
                {unpricedCount > 0 && ` (${unpricedCount} with price to come)`}
              </p>
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

        {/* Paper and a copy are the same receipt, which is why they sit
            together: this modal already answers "what is on it". */}
        <button
          onClick={handleSend}
          disabled={sending || isLoading || !swapId || !seller.receiptChannel}
          className="w-full bg-surface-100 hover:bg-surface-200 border border-gray-600 disabled:opacity-40 text-white py-2 rounded text-sm font-medium"
        >
          {sending
            ? 'Sending…'
            : seller.receiptChannel === 'SMS'
              ? 'Text Receipt'
              : 'Email Receipt'}
        </button>
        {/* Said before the press rather than after it. The server refuses this
            case in a sentence, but an action that cannot work should not look
            like one that can. */}
        {!seller.receiptChannel && (
          <p className="text-xs text-center text-gray-500">
            No verified {sms ? 'email or phone' : 'email'} on file, so there is nowhere to send it.
          </p>
        )}

        {sent && (
          <p className="text-xs text-center text-green-400">
            {sent.status === 'SUPPRESSED'
              ? /* Notifications are off on this deployment. Saying "sent" would
                   be a lie the volunteer cannot check. */
                `Recorded for ${sent.destination} — sending is switched off here`
              : `Sent to ${sent.destination}`}
          </p>
        )}
        {sendError && <p className="text-red-400 text-xs text-center">{sendError}</p>}
        {!sent && !sendError && lastDelivery && (
          <p className="text-xs text-center text-gray-500">
            Last sent to {lastDelivery.destination} ·{' '}
            {new Date(lastDelivery.createdAt).toLocaleString(undefined, {
              month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}
          </p>
        )}

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
