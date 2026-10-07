import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TicketImportResult, TicketSeller } from '../../lib/api.types';
import { GenerateSkusSwitch, wroteAny } from './ImportSkuOptions';
import ImportFileGuide, { markImportGuideSeen } from './ImportFileGuide';
import ImportResultPanel from './ImportResultPanel';

/** "67000–67499", or two blocks for a shop given a second pad. */
function describeRanges(s: TicketSeller): string {
  return s.ranges.map((r) => `${r.startNumber}–${r.endNumber}`).join(', ');
}

/**
 * A shop's inventory, uploaded by staff on the shop's behalf.
 *
 * The seller is chosen here rather than implied by the screen, which is the one
 * thing this has that the shop's own upload does not — and the one way it can
 * go wrong. Three things make a wrong choice a refusal rather than a mess: only
 * sellers holding tickets in this swap are offered, their ranges are shown
 * beside the picker before a file is read, and the server refuses any number
 * outside those ranges by name. Nothing is written unless every row passes,
 * or, for categories and details we don't know, until staff import anyway
 * (Plan 42).
 */
export default function ProxyItemImportModal({
  orgId,
  swapId,
  allowGenerate,
  onClose,
  onImported,
}: {
  orgId: string;
  swapId: string;
  /** The swap's web isn't tickets-only, so rows without a ticket may get a SKU (Plan 31). */
  allowGenerate: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [sellerId, setSellerId] = useState('');
  const [generateSkus, setGenerateSkus] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<TicketImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: sellers = [], isLoading } = useQuery({
    queryKey: ['ski-swap/ticket-sellers', orgId, swapId],
    queryFn: () => api.skiSwap.listTicketSellers(orgId, swapId),
    enabled: !!swapId,
  });

  const chosen = sellers.find((s) => s.sellerId === sellerId) ?? null;
  const wrote = result?.refused === null && wroteAny(result.rows);
  const clear = () => { setResult(null); setError(''); };

  async function submit(acceptUnknown = false) {
    if (!file || !sellerId) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.skiSwap.importItemsForSeller(orgId, swapId, sellerId, file, {
        generateSkus: allowGenerate && generateSkus,
        acceptUnknown,
      });
      markImportGuideSeen();
      if (!res.success || !res.data) {
        setResult(null);
        setError(res.error ?? 'Could not read that file');
      } else {
        setResult(res.data);
        if (res.data.refused === null && wroteAny(res.data.rows)) onImported();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-lg w-full space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-white font-medium">Import items for a seller</h3>

        <label className="block space-y-1">
          <span className="block text-xs text-gray-400 uppercase tracking-wider">Seller</span>
          <select
            value={sellerId}
            onChange={(e) => { setSellerId(e.target.value); clear(); }}
            disabled={isLoading || sellers.length === 0}
            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            <option value="">
              {isLoading ? 'Loading…' : sellers.length ? 'Choose a seller…' : 'No seller can be uploaded for in this swap'}
            </option>
            {sellers.map((s) => (
              <option key={s.sellerId} value={s.sellerId}>{s.displayName}</option>
            ))}
          </select>
          {/* Shown before the file is read, so the wrong shop is visible at the
              point of choosing rather than only in a page of failures. */}
          {chosen && (
            <span className="block text-xs text-gray-500">
              {chosen.ranges.length
                ? `Tickets ${describeRanges(chosen)}: ${chosen.usedCount} of ${chosen.ticketCount} described`
                : 'No tickets in this swap: every row needs a generated SKU.'}
            </span>
          )}
        </label>

        <p className="text-sm text-gray-400">
          A ticket row fills in that issued ticket. Rows for numbers the seller doesn’t hold are refused.
        </p>
        <ImportFileGuide download={(f) => api.skiSwap.itemImportFile(orgId, swapId, f)} allowGenerate={allowGenerate} />

        {allowGenerate && (
          <GenerateSkusSwitch checked={generateSkus} onChange={(on) => { setGenerateSkus(on); clear(); }} />
        )}

        <input
          type="file"
          accept=".csv,text/csv"
          disabled={!sellerId}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); clear(); }}
          className="block w-full text-sm text-gray-300 disabled:opacity-40 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-surface-100 file:text-gray-200"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        {result && (
          <ImportResultPanel
            result={result}
            forWhom={chosen?.displayName ?? 'this seller'}
            busy={busy}
            onImportAnyway={() => submit(true)}
          />
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-white px-3 py-2">
            {wrote ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={() => submit()}
            disabled={!file || !sellerId || busy || wrote}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
