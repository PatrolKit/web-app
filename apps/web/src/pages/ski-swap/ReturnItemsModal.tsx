import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  faCircleCheck as faCircleCheckDuo, faCircleXmark as faCircleXmarkDuo, faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import { useScanner } from '../../contexts/ScannerContext';
import SearchableSelect from '../../components/SearchableSelect';
import { Banner, ScannerBanner, TypedCode, errorTone } from './ScanSessionParts';
import {
  bannerFor, canUndoReturn, counts, isRefused, isReturned, landed, refused, resent, scanned, stillOut, undone,
  type ReturnOutcome, type ReturnRow,
} from './returnItemsLogic';

const money = (cents: number | null) => (cents === null ? 'No price' : `$${(cents / 100).toFixed(2)}`);

const ICON = { ready: faCircleCheckDuo, warn: faTriangleExclamationDuo, error: faCircleXmarkDuo } as const;

const BADGE: Record<ReturnOutcome, { label: string; tone: string }> = {
  sending: { label: 'Returning…', tone: 'bg-surface-200 text-gray-300' },
  returned: { label: 'Returned', tone: 'bg-green-900/50 text-green-300' },
  already: { label: 'Already returned', tone: 'bg-green-900/30 text-green-400' },
  unchecked: { label: 'Returned · Square unchecked', tone: 'bg-amber-900/40 text-amber-300' },
  undone: { label: 'Back on sale', tone: 'bg-amber-900/40 text-amber-300' },
  sold: { label: 'Sold', tone: 'bg-red-900/50 text-red-300' },
  wrong_seller: { label: 'Not this seller’s', tone: 'bg-red-900/50 text-red-300' },
  not_received: { label: 'Never accepted', tone: 'bg-red-900/50 text-red-300' },
  not_found: { label: 'Not found', tone: 'bg-red-900/50 text-red-300' },
  not_sent: { label: 'Not sent', tone: 'bg-red-900/50 text-red-300' },
  failed: { label: 'Not returned', tone: 'bg-red-900/50 text-red-300' },
};

/**
 * Return Items (Plan 43): hand unsold items back to their sellers, one scan
 * at a time. Each scan returns its item at once (one request per scan, so
 * what the screen says is what was done) and answers on a big banner: green
 * returned, amber returned with a caveat, red refused, with the error tone.
 * The session's scans are listed underneath, newest first.
 *
 * Open to any seller's items by default; lock it to one seller and another
 * seller's item is refused, and that seller's items still out are listed.
 */
export default function ReturnItemsModal({ orgId, swapId, sellers, lockedTo, onClose, onChanged }: {
  orgId: string;
  swapId: string;
  sellers: SellerResponse[];
  /** Opened from a seller's page: locked to them to start with. */
  lockedTo?: string;
  onClose: () => void;
  /** Something was returned or undone: the Items list should refresh. */
  onChanged: () => void;
}) {
  const { subscribe } = useScanner();
  const [sellerId, setSellerId] = useState(lockedTo ?? '');
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const rowsRef = useRef(rows);
  const nextKey = useRef(1);
  const sellerRef = useRef(sellerId);
  sellerRef.current = sellerId;
  /** The row shown large: the newest, unless one in the list was picked. */
  const [pickedKey, setPickedKey] = useState<number | null>(null);

  const commit = (next: ReturnRow[]) => { rowsRef.current = next; setRows(next); };

  const { data: unreturned, refetch: refetchUnreturned } = useQuery({
    queryKey: ['ski-swap/unreturned', orgId, swapId, sellerId],
    queryFn: () => api.skiSwap.unreturnedItems(orgId, swapId, sellerId),
    enabled: !!sellerId,
  });

  function send(key: number, code: string) {
    api.skiSwap.returnItemBySku(orgId, swapId, code, sellerRef.current || undefined)
      .then((result) => {
        commit(landed(rowsRef.current, key, result));
        if (result.outcome === 'returned') onChanged();
      })
      .catch((err: unknown) => {
        errorTone();
        commit(refused(rowsRef.current, key, err instanceof ApiError
          ? { status: err.status, code: err.code, message: err.message }
          // No answer at all: the network.
          : {}));
      });
  }

  function scan(raw: string) {
    const key = nextKey.current++;
    const r = scanned(rowsRef.current, raw, key);
    if (!r.code) return;
    commit(r.rows);
    setPickedKey(null);
    send(key, r.code);
  }
  const scanRef = useRef(scan);
  scanRef.current = scan;

  // Every scan, for as long as the popover is open.
  useEffect(() => subscribe((s) => scanRef.current(s.payload)), [subscribe]);

  function retry(row: ReturnRow) {
    commit(resent(rowsRef.current, row.key));
    setPickedKey(row.key);
    send(row.key, row.code);
  }

  async function undo(row: ReturnRow) {
    if (!row.item || !confirm(`Put ${row.item.sku} back on sale? It goes back in Square.`)) return;
    try {
      const item = await api.skiSwap.undoItemReturn(orgId, swapId, row.item.id);
      commit(undone(rowsRef.current, row.key, item));
      setPickedKey(row.key);
      onChanged();
      if (sellerId) void refetchUnreturned();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not undo the return.');
    }
  }

  const shown = rows.find((r) => r.key === pickedKey) ?? rows[0] ?? null;
  const banner = shown ? bannerFor(shown) : null;
  const tally = counts(rows);
  const locked = sellers.find((s) => s.id === sellerId) ?? null;
  const out = unreturned ? stillOut(unreturned.items, rows) : null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 pt-[5vh] z-50" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Return items"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-3xl p-5 space-y-4 max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-white font-medium">Return items</h3>
            <p className="text-gray-400 text-sm mt-0.5">
              Scan each unsold item as it goes back to its seller. Each scan returns it at once and takes it out of Square.
            </p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 bg-surface-100 hover:bg-surface-200 text-gray-200 px-3 py-1.5 rounded text-sm">
            Done
          </button>
        </div>

        <div className="shrink-0 flex flex-wrap items-center gap-3">
          <span className="text-xs uppercase text-gray-400">Returning for</span>
          <SearchableSelect
            value={sellerId}
            onChange={setSellerId}
            options={sellers.map((s) => ({ value: s.id, label: s.displayName, ...(s.phone ? { sublabel: s.phone } : {}) }))}
            placeholder="Any seller"
            clearLabel="Any seller"
            emptyMessage="No sellers match."
            className="w-72"
            ariaLabel="Returning for"
          />
          <span className="text-xs text-gray-500">
            {locked ? `Only ${locked.displayName}’s items are returned; another seller’s is refused.` : 'Any seller’s items are returned.'}
          </span>
        </div>

        <ScannerBanner ready={{ title: rows.length ? 'Keep scanning' : 'Start scanning', text: 'Scan an item’s tag to return it to its seller.' }} />

        {banner && shown && (
          <Banner tone={banner.tone} icon={ICON[banner.tone]} title={banner.title} text={banner.text}
            action={shown.outcome === 'not_sent' ? (
              <button type="button" onClick={() => retry(shown)} className="bg-red-700 hover:bg-red-600 text-white px-3 py-1.5 rounded text-sm font-medium">Retry</button>
            ) : undefined} />
        )}
        {shown?.outcome === 'sending' && (
          <div className="shrink-0 bg-surface-100 rounded-lg px-4 py-3">
            <p className="text-2xl font-mono font-bold text-white">{shown.code}</p>
            <p className="text-sm text-gray-500">Returning…</p>
          </div>
        )}

        <TypedCode placeholder="Barcode won’t read? Type the SKU" onEnter={scan} button="Return" />

        <div className="flex-1 min-h-0 flex gap-4">
          <div className="flex-1 min-w-0 flex flex-col">
            <p className="text-xs text-gray-400 mb-1 shrink-0">
              This session: {tally.returned.toLocaleString('en-US')} returned · {tally.refused.toLocaleString('en-US')} refused
            </p>
            <ul className="flex-1 min-h-0 overflow-y-auto border border-gray-800 rounded divide-y divide-gray-800" aria-label="Scanned this session">
              {rows.length === 0 && <li className="px-3 py-3 text-sm text-gray-500">Each scan is listed here, newest first.</li>}
              {rows.map((r) => (
                <li key={r.key} className={`flex items-center gap-3 px-3 py-1.5 text-sm ${shown?.key === r.key ? 'bg-surface-100' : ''}`}>
                  <button type="button" onClick={() => setPickedKey(r.key)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                    <span className="font-mono text-gray-200 shrink-0">{r.code}</span>
                    <span className="truncate text-gray-400">
                      {r.item ? [r.item.seller?.displayName, r.item.name].filter(Boolean).join(' · ') : (isRefused(r.outcome) ? r.message ?? '' : '')}
                    </span>
                  </button>
                  {r.item && <span className="text-gray-300 shrink-0">{money(r.item.priceCents)}</span>}
                  <span className={`shrink-0 inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${BADGE[r.outcome].tone}`}>
                    {BADGE[r.outcome].label}
                  </span>
                  {isReturned(r.outcome) && r.outcome !== 'already' && r.item && canUndoReturn(r.item) && (
                    <button type="button" onClick={() => void undo(r)} className="shrink-0 text-xs text-gray-400 hover:text-white">Undo</button>
                  )}
                  {r.outcome === 'not_sent' && (
                    <button type="button" onClick={() => retry(r)} className="shrink-0 text-xs text-red-300 hover:text-white">Retry</button>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {locked && (
            <div className="w-64 shrink-0 flex flex-col">
              <p className="text-xs text-gray-400 mb-1 shrink-0">
                {locked.displayName}: {out === null ? '…' : out.length === 0 ? 'all returned' : `${out.length.toLocaleString('en-US')} still out`}
                {unreturned && !unreturned.squareChecked ? ' (couldn’t check Square)' : ''}
              </p>
              <ul className="flex-1 min-h-0 overflow-y-auto border border-gray-800 rounded divide-y divide-gray-800" aria-label="Still out">
                {out?.length === 0 && <li className="px-3 py-3 text-sm text-green-400">All returned.</li>}
                {out?.map((i) => (
                  <li key={i.id} className="px-3 py-1.5 text-sm flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate"><span className="font-mono text-gray-200">{i.sku}</span> <span className="text-gray-400">{i.name}</span></span>
                    {i.units > 1 && <span className="text-xs text-gray-500 shrink-0">×{i.units}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
