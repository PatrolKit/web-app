import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { TicketImportRow, TicketSeller } from '../../lib/api.types';

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
 * outside those ranges by name. Nothing is written unless every row passes.
 */
export default function ProxyItemImportModal({
  orgId,
  swapId,
  onClose,
  onImported,
}: {
  orgId: string;
  swapId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [sellerId, setSellerId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<TicketImportRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: sellers = [], isLoading } = useQuery({
    queryKey: ['ski-swap/ticket-sellers', orgId, swapId],
    queryFn: () => api.skiSwap.listTicketSellers(orgId, swapId),
    enabled: !!swapId,
  });

  const chosen = sellers.find((s) => s.sellerId === sellerId) ?? null;
  const failures = rows?.filter((r) => r.outcome === 'error') ?? [];
  const created = rows?.filter((r) => r.outcome === 'created') ?? [];

  async function submit() {
    if (!file || !sellerId) return;
    setBusy(true);
    setError('');
    setRows(null);
    try {
      const res = await api.skiSwap.importItemsForSeller(orgId, swapId, sellerId, file);
      if (!res.success) {
        setError(res.error ?? 'Could not read that file');
      } else {
        setRows(res.data ?? []);
        if ((res.data ?? []).some((r) => r.outcome === 'created')) onImported();
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
            onChange={(e) => { setSellerId(e.target.value); setRows(null); setError(''); }}
            disabled={isLoading || sellers.length === 0}
            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white disabled:opacity-50"
          >
            <option value="">
              {isLoading ? 'Loading…' : sellers.length ? 'Choose a seller…' : 'Nobody holds tickets in this swap'}
            </option>
            {sellers.map((s) => (
              <option key={s.sellerId} value={s.sellerId}>{s.displayName}</option>
            ))}
          </select>
          {/* Shown before the file is read, so the wrong shop is visible at the
              point of choosing rather than only in a page of failures. */}
          {chosen && (
            <span className="block text-xs text-gray-500">
              Tickets {describeRanges(chosen)} — {chosen.usedCount} of {chosen.ticketCount} used
            </span>
          )}
        </label>

        <div className="text-sm text-gray-400 space-y-2">
          <p>
            One row per ticket. The number and the price are required; a name and a
            description are not. Without a name the item is called after the shop and
            the number.
          </p>
          <pre className="bg-surface-100 border border-gray-700 rounded p-3 text-xs text-gray-300 overflow-x-auto">
{`sku,price,name,description
67169,250.00,Rossignol Experience 88 skis,"170cm, edges good"
67170,180.00,Salomon QST boots,27.5 mondo
67171,45.00,,Poles`}
          </pre>
        </div>

        <input
          type="file"
          accept=".csv,text/csv"
          disabled={!sellerId}
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setRows(null); setError(''); }}
          className="block w-full text-sm text-gray-300 disabled:opacity-40 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-surface-100 file:text-gray-200"
        />

        {error && <p className="text-sm text-red-400">{error}</p>}

        {rows && failures.length > 0 && (
          <div className="space-y-2">
            {/* Nothing was written: the file is reported whole so every problem
                can be fixed in one pass rather than one upload at a time. */}
            <p className="text-sm text-amber-400">
              Nothing was imported for {chosen?.displayName ?? 'this seller'}.{' '}
              {failures.length} row{failures.length === 1 ? '' : 's'} need
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
          <p className="text-sm text-green-400">
            {created.length} item{created.length === 1 ? '' : 's'} imported for{' '}
            {chosen?.displayName ?? 'this seller'}.
          </p>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="text-sm text-gray-400 hover:text-white px-3 py-2">
            {created.length > 0 ? 'Done' : 'Cancel'}
          </button>
          <button
            onClick={submit}
            disabled={!file || !sellerId || busy}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
          >
            {busy ? 'Checking…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
