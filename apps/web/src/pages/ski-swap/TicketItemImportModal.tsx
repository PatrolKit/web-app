import { useState } from 'react';
import { api } from '../../lib/api';
import type { TicketImportResult } from '../../lib/api.types';
import { GenerateSkusSwitch, wroteAny } from './ImportSkuOptions';
import ImportFileGuide, { markImportGuideSeen } from './ImportFileGuide';
import ImportResultPanel from './ImportResultPanel';

/**
 * A shop's whole inventory in one file.
 *
 * The ticket number, an optional name and description, a price, which a
 * ticket row may leave blank to be priced later (Plan 32), and what the item
 * is (Plan 42). Nothing is written unless every row passes — a half-imported
 * inventory is worse than a rejected one, because the seller cannot tell which
 * half went in — or, for categories and details we don't know, until the shop
 * imports anyway.
 *
 * Rows may skip numbers and go backwards. What the item form suggests has no
 * say here; a pad worked through out of order is exactly the file this accepts.
 */
export default function TicketItemImportModal({
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
  const [file, setFile] = useState<File | null>(null);
  const [generateSkus, setGenerateSkus] = useState(false);
  const [result, setResult] = useState<TicketImportResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const wrote = result?.refused === null && wroteAny(result.rows);
  const clear = () => { setResult(null); setError(''); };

  async function submit(acceptUnknown = false) {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.skiSwap.importTicketItems(orgId, swapId, file, {
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
        <h3 className="text-white font-medium">Import items from a file</h3>

        <p className="text-sm text-gray-400">
          A row describes one of your tickets, which can be done once. A ticket left unpriced is priced at the register.
        </p>
        <ImportFileGuide download={(f) => api.skiSwap.ticketImportFile(orgId, f)} allowGenerate={allowGenerate} />

        {allowGenerate && (
          <GenerateSkusSwitch checked={generateSkus} onChange={(on) => { setGenerateSkus(on); clear(); }} />
        )}

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); clear(); }}
          className="block w-full text-sm text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-surface-100 file:text-gray-200"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        {result && <ImportResultPanel result={result} busy={busy} onImportAnyway={() => submit(true)} />}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-white px-3 py-2">
            {wrote ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={() => submit()}
            disabled={!file || busy || wrote}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
