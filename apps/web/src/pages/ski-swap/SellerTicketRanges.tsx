import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

const numberClass =
  'w-24 bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white';

/**
 * The blocks of pre-printed tickets issued to a business seller for one swap.
 *
 * Ranges are typed rather than allocated: the app is told which block went to a
 * shop, it does not decide. So the overlap check on the server is the only
 * thing standing between two shops and the same number, and a refusal here is
 * worth reading rather than dismissing.
 *
 * A seller on tickets has no printer and vice versa (D1), which the server
 * enforces from both directions — this screen only reports it.
 */
export default function SellerTicketRanges({
  orgId,
  sellerId,
  swapId,
  swapTitle,
  canAdmin,
}: {
  orgId: string;
  sellerId: string;
  /** Ranges belong to a swap; without one there is nothing to show. */
  swapId: string | null;
  swapTitle: string | null;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');

  const { data: ranges = [], isLoading } = useQuery({
    queryKey: ['ski-swap/ticket-ranges', orgId, sellerId, swapId],
    queryFn: () => api.skiSwap.listTicketRanges(orgId, sellerId, swapId!),
    enabled: !!swapId,
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['ski-swap/ticket-ranges', orgId, sellerId, swapId] });

  const add = useMutation({
    mutationFn: () =>
      api.skiSwap.addTicketRange(orgId, sellerId, {
        swapId: swapId!,
        startNumber: Number(from),
        endNumber: Number(to),
      }),
    onSuccess: () => { setFrom(''); setTo(''); setError(''); void invalidate(); },
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: (rangeId: string) => api.skiSwap.removeTicketRange(orgId, sellerId, rangeId),
    onSuccess: () => { setError(''); void invalidate(); },
    onError: (e: Error) => setError(e.message),
  });

  if (!swapId) {
    return (
      <div className="space-y-2 pt-1 border-t border-gray-700">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Tickets</p>
        <p className="text-xs text-gray-500">
          Ticket ranges belong to a swap, and none is running. Start one on the Swaps tab.
        </p>
      </div>
    );
  }

  const ready = /^\d+$/.test(from) && /^\d+$/.test(to);

  return (
    <div className="space-y-2 pt-1 border-t border-gray-700">
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">
        Tickets{swapTitle ? ` — ${swapTitle}` : ''}
      </p>
      <p className="text-xs text-gray-500">
        Blocks of pre-printed tickets issued to this shop. A seller on tickets does not
        also get a printer.
      </p>

      {isLoading ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : ranges.length === 0 ? (
        <p className="text-xs text-gray-500">No ticket ranges — this seller prints their own tags.</p>
      ) : (
        <ul className="space-y-1">
          {ranges.map((r) => (
            <li key={r.id} className="flex items-center gap-3 text-sm">
              <span className="font-mono text-gray-200">
                {r.startNumber}–{r.endNumber}
              </span>
              <span className="text-xs text-gray-500">
                {r.ticketCount} ticket{r.ticketCount === 1 ? '' : 's'}, {r.usedCount} used
              </span>
              {canAdmin && (
                <button
                  type="button"
                  onClick={() => remove.mutate(r.id)}
                  disabled={remove.isPending}
                  className="text-xs text-red-500 hover:underline ml-auto disabled:opacity-40"
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAdmin && (
        <div className="flex items-center gap-2 pt-1">
          <input
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="from"
            inputMode="numeric"
            className={numberClass}
          />
          <span className="text-gray-600">–</span>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="to"
            inputMode="numeric"
            className={numberClass}
          />
          <button
            type="button"
            onClick={() => add.mutate()}
            disabled={!ready || add.isPending}
            className="text-xs px-3 py-1.5 bg-surface-100 hover:bg-surface-200 text-gray-200 rounded disabled:opacity-40"
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
