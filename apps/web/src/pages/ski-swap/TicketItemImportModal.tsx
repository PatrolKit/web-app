import { useState } from 'react';
import { api } from '../../lib/api';
import type { TicketImportRow } from '../../lib/api.types';
import { GenerateSkusSwitch, importedSummary, wroteAny } from './ImportSkuOptions';

/**
 * A shop's whole inventory in one file.
 *
 * Three columns: the ticket number, an optional name, and a price, which a
 * ticket row may leave blank to be priced later (Plan 32). Nothing is
 * written unless every row passes — a half-imported inventory is worse than a
 * rejected one, because the seller cannot tell which half went in.
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
  const [rows, setRows] = useState<TicketImportRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const failures = rows?.filter((r) => r.outcome === 'error') ?? [];
  const created = rows?.filter((r) => r.outcome === 'created' || r.outcome === 'updated') ?? [];

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError('');
    setRows(null);
    try {
      const res = await api.skiSwap.importTicketItems(orgId, swapId, file, allowGenerate && generateSkus);
      if (!res.success) {
        setError(res.error ?? 'Could not read that file');
      } else {
        setRows(res.data ?? []);
        if (wroteAny(res.data)) onImported();
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

        <div className="text-sm text-gray-400 space-y-2">
          <p>
            One row per ticket: it describes that ticket, which can be done once. The ticket
            number is required{allowGenerate ? ', unless SKUs are generated below for items without a ticket, which need a price' : ''}.
            A name and a price are optional; a ticket left unpriced is priced at the register.
          </p>
          <pre className="bg-surface-100 border border-gray-700 rounded p-3 text-xs text-gray-300 overflow-x-auto">
{`sku,name,price
67169,Rossignol Experience 88 skis 170cm,250.00
67170,,180.00
67171,Salomon QST boots,`}
          </pre>
        </div>

        {allowGenerate && (
          <GenerateSkusSwitch checked={generateSkus} onChange={(on) => { setGenerateSkus(on); setRows(null); setError(''); }} />
        )}

        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRows(null); setError(''); }}
          className="block w-full text-sm text-gray-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-surface-100 file:text-gray-200"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        {rows && failures.length > 0 && (
          <div className="space-y-2">
            {/* Nothing was written: the file is reported whole so every problem
                can be fixed in one pass rather than one upload at a time. */}
            <p className="text-sm text-amber-400">
              Nothing was imported. {failures.length} row{failures.length === 1 ? '' : 's'} need
              {failures.length === 1 ? 's' : ''} fixing first.
            </p>
            <ul className="space-y-1 text-xs">
              {failures.map((r) => (
                <li key={r.line} className="text-gray-400">
                  <span className="text-gray-500">Line {r.line}</span>
                  {r.sku ? <span className="font-mono text-gray-300"> {r.sku}</span> : null}
                  {' — '}
                  <span className="text-red-400">{r.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {rows && failures.length === 0 && created.length > 0 && (
          <p className="text-sm text-green-400">{importedSummary(created)}</p>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-white px-3 py-2">
            {created.length > 0 ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={submit}
            disabled={!file || busy}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
