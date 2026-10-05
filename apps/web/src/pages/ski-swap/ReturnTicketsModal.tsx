import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { RemoveTicketsResult, TicketSeller } from '../../lib/api.types';
import { runsText } from './IssueTicketRangeModal';

const inputClass = 'w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white font-mono';

/**
 * Take back the tickets a shop returned unused (Plan 38, D10): in a span, its
 * tickets nobody has described, priced or sold are removed, here and in Square.
 * The rest are kept and listed with why.
 */
export default function ReturnTicketsModal({ orgId, swapId, holders, onClose, onRemoved }: {
  orgId: string;
  swapId: string;
  /** Shops holding tickets in this swap. */
  holders: TicketSeller[];
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [sellerId, setSellerId] = useState(holders.length === 1 ? holders[0].sellerId : '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<RemoveTicketsResult | null>(null);

  const holder = holders.find((h) => h.sellerId === sellerId) ?? null;
  const valid = !!holder && /^\d+$/.test(from) && /^\d+$/.test(to) && Number(from) <= Number(to);

  const remove = useMutation({
    mutationFn: () => api.skiSwap.removeTickets(orgId, sellerId, {
      swapId, startNumber: Number(from), endNumber: Number(to),
    }),
    onSuccess: (r) => { setError(''); setResult(r); onRemoved(); },
    onError: (e: Error) => { setResult(null); setError(e.message); },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || remove.isPending) return;
    remove.mutate();
  }

  function reset() { setResult(null); setError(''); }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <form
        onSubmit={submit}
        className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-sm w-full space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white font-medium">Return Unused Tickets</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white text-lg leading-none">×</button>
        </div>

        <p className="text-xs text-gray-500">
          Removes the shop’s tickets in the range that nobody has described, priced or sold, here and in Square.
          Any others are kept, and listed below.
        </p>

        <div className="space-y-1">
          <select
            value={sellerId}
            onChange={(e) => { setSellerId(e.target.value); reset(); }}
            aria-label="Shop"
            className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            {holders.length !== 1 && <option value="">Choose a shop…</option>}
            {holders.map((h) => <option key={h.sellerId} value={h.sellerId}>{h.displayName}</option>)}
          </select>
          {holder && (
            <p className="text-xs text-gray-500">
              Holds <span className="font-mono text-gray-300">{runsText(holder.ranges)}</span>{' '}
              ({holder.ticketCount.toLocaleString('en-US')}, {holder.usedCount.toLocaleString('en-US')} described).
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-gray-400 mb-1 block">First ticket</span>
            <input value={from} inputMode="numeric" className={inputClass}
              onChange={(e) => { setFrom(e.target.value.replace(/\D/g, '')); reset(); }} />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400 mb-1 block">Last ticket</span>
            <input value={to} inputMode="numeric" className={inputClass}
              onChange={(e) => { setTo(e.target.value.replace(/\D/g, '')); reset(); }} />
          </label>
        </div>

        <button
          type="submit"
          disabled={!valid || remove.isPending}
          className="w-full bg-red-700 hover:bg-red-800 disabled:opacity-40 text-white py-2 rounded text-sm font-medium"
        >
          {remove.isPending ? 'Removing…' : 'Remove Unused Tickets'}
        </button>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {result && (
          <div className="space-y-1">
            <p className="text-xs text-green-400">
              Removed {result.removed.toLocaleString('en-US')} ticket{result.removed === 1 ? '' : 's'}.
            </p>
            {result.kept.length > 0 && (
              <>
                <p className="text-xs text-amber-400">Kept {result.kept.length.toLocaleString('en-US')}:</p>
                <ul className="text-xs text-gray-300 max-h-40 overflow-y-auto space-y-0.5">
                  {result.kept.map((k) => (
                    <li key={k.sku}><span className="font-mono">{k.sku}</span> <span className="text-gray-500">{k.why}</span></li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
