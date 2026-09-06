import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

const numberClass =
  'w-24 bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white';

type Tab = 'printer' | 'tickets';

function tabClass(active: boolean): string {
  return [
    'text-xs px-3 py-1.5 rounded transition-colors',
    active ? 'bg-surface-100 text-white' : 'text-gray-500 hover:text-gray-300',
  ].join(' ');
}

/**
 * Where this seller's tags come from: a printer of their own, or a block of
 * tickets the organisation issued them.
 *
 * Tabs rather than two sections, because these are alternatives — a seller with
 * both would have two SKUs competing for one item, and the server refuses the
 * combination from either direction. The tab that does not apply says why
 * instead of offering a control that would be refused.
 *
 * Assignment lives here rather than on the Printers page: it is a fact about
 * the seller, and choosing between the two answers is impossible on a screen
 * that only knows about one of them.
 */
export default function SellerTicketSource({
  orgId,
  sellerId,
  swapId,
  swapTitle,
  canAdmin,
}: {
  orgId: string;
  sellerId: string;
  /** Ranges belong to a swap; a printer does not. */
  swapId: string | null;
  swapTitle: string | null;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');

  const rangesKey = ['ski-swap/ticket-ranges', orgId, sellerId, swapId];
  const printersKey = ['ski-swap/printers', orgId];

  const { data: ranges = [] } = useQuery({
    queryKey: rangesKey,
    queryFn: () => api.skiSwap.listTicketRanges(orgId, sellerId, swapId!),
    enabled: !!swapId,
  });

  const { data: printers = [] } = useQuery({
    queryKey: printersKey,
    queryFn: () => api.skiSwap.listPrinters(orgId),
    enabled: !!orgId,
  });

  const mine = printers.find((p) => p.assignedSellerId === sellerId) ?? null;
  const hasRanges = ranges.length > 0;

  // Opens on whichever answer is already true, so the page reflects the seller
  // rather than a default.
  const [tab, setTab] = useState<Tab>(hasRanges ? 'tickets' : 'printer');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: rangesKey });
    void qc.invalidateQueries({ queryKey: printersKey });
  };

  const assign = useMutation({
    mutationFn: (printerId: string | null) =>
      // Unassigning targets whichever printer this seller currently holds;
      // assigning targets the chosen one.
      api.skiSwap.patchPrinter(orgId, printerId ?? mine!.id, {
        assignedSellerId: printerId ? sellerId : null,
      }),
    onSuccess: () => { setError(''); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const addRange = useMutation({
    mutationFn: () =>
      api.skiSwap.addTicketRange(orgId, sellerId, {
        swapId: swapId!,
        startNumber: Number(from),
        endNumber: Number(to),
      }),
    onSuccess: () => { setFrom(''); setTo(''); setError(''); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  const removeRange = useMutation({
    mutationFn: (rangeId: string) => api.skiSwap.removeTicketRange(orgId, sellerId, rangeId),
    onSuccess: () => { setError(''); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  /**
   * Printers this seller could be given: nothing else is using them.
   *
   * A printer driven by a bridge is held by that bridge continuously, so
   * handing it to a seller as well means the bridge wins and the seller's
   * printing stops with nothing on screen to say why. Their own stays listed so
   * the dropdown can show what it is set to.
   */
  const available = printers.filter(
    (p) => p.id === mine?.id || (!p.assignedSellerId && !p.bridgeDeviceId),
  );

  return (
    <div className="space-y-2 pt-1 border-t border-gray-700">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Ticket source</p>
        <div className="flex gap-1">
          <button type="button" className={tabClass(tab === 'printer')} onClick={() => { setTab('printer'); setError(''); }}>
            Printer
          </button>
          <button type="button" className={tabClass(tab === 'tickets')} onClick={() => { setTab('tickets'); setError(''); }}>
            Issued tickets
          </button>
        </div>
      </div>

      {tab === 'printer' && (
        hasRanges ? (
          <p className="text-xs text-gray-500">
            This seller uses issued tickets. Remove their ranges before assigning a printer.
          </p>
        ) : (
          <>
            <select
              value={mine?.id ?? ''}
              disabled={!canAdmin || assign.isPending}
              onChange={(e) => assign.mutate(e.target.value || null)}
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              <option value="">— no printer —</option>
              {available.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500">
              {mine
                ? 'This seller prints their own tags over Bluetooth.'
                : available.length === 0
                  ? 'No printer is free. Add one on the Printers page, or release one from its bridge.'
                  : 'Give this seller a printer, or issue them tickets instead.'}
            </p>
          </>
        )
      )}

      {tab === 'tickets' && (
        mine ? (
          <p className="text-xs text-gray-500">
            This seller has a printer ({mine.name}). Unassign it before issuing tickets.
          </p>
        ) : !swapId ? (
          <p className="text-xs text-gray-500">
            Ticket ranges belong to a swap, and none is running. Start one on the Swaps tab.
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-500">
              Blocks of pre-printed tickets issued to this shop{swapTitle ? ` for ${swapTitle}` : ''}.
            </p>
            {ranges.length === 0 ? (
              <p className="text-xs text-gray-500">No ranges issued yet.</p>
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
                        onClick={() => removeRange.mutate(r.id)}
                        disabled={removeRange.isPending}
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
                <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="from" inputMode="numeric" className={numberClass} />
                <span className="text-gray-600">–</span>
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="to" inputMode="numeric" className={numberClass} />
                <button
                  type="button"
                  onClick={() => addRange.mutate()}
                  disabled={!/^\d+$/.test(from) || !/^\d+$/.test(to) || addRange.isPending}
                  className="text-xs px-3 py-1.5 bg-surface-100 hover:bg-surface-200 text-gray-200 rounded disabled:opacity-40"
                >
                  {addRange.isPending ? 'Adding…' : 'Add'}
                </button>
              </div>
            )}
          </>
        )
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
