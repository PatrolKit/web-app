import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

/**
 * The shop's label printer (Plan 31), for items without a ticket. Tickets are
 * issued from the Sellers list's row action, and returned from the Items page
 * (Plan 38).
 *
 * The swap is chosen here rather than taken from the page: whether the web may
 * use a printer at all is a swap setting (its "Web UI: legacy tickets only").
 * The printer itself is the seller's across swaps.
 *
 * Assignment lives here rather than on the Printers page: it is a fact about
 * the seller.
 */
export default function SellerTicketSource({
  orgId,
  sellerId,
  initialSwapId,
  canAdmin,
}: {
  orgId: string;
  sellerId: string;
  /** The swap selected in the Ski Swap layout, which the dropdown starts on. */
  initialSwapId: string | null;
  canAdmin: boolean;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const { data: swaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps-all', orgId],
    queryFn: () => api.skiSwap.listSwaps(orgId),
    enabled: !!orgId,
  });
  const [chosenSwapId, setChosenSwapId] = useState<string | null>(initialSwapId);
  const swap = swaps.find((s) => s.id === chosenSwapId) ?? swaps[0] ?? null;
  const swapId = swap?.id ?? null;

  const printersKey = ['ski-swap/printers', orgId];

  const { data: printers = [] } = useQuery({
    queryKey: printersKey,
    queryFn: () => api.skiSwap.listPrinters(orgId),
    enabled: !!orgId,
  });

  const mine = printers.find((p) => p.assignedSellerId === sellerId) ?? null;
  const webTicketsOnly = swap ? !swap.allowPrintWeb : false;

  /** A printer is on offer unless this swap's web takes tickets only; one already assigned stays listed. */
  const printerShown = !webTicketsOnly || !!mine;

  const refresh = () => void qc.invalidateQueries({ queryKey: printersKey });

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
    <div className="space-y-3 pt-1 border-t border-gray-700">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider shrink-0">Labels for</p>
        <select
          value={swapId ?? ''}
          onChange={(e) => { setChosenSwapId(e.target.value || null); setError(''); }}
          disabled={swaps.length === 0}
          className="flex-1 min-w-0 bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white disabled:opacity-50"
          aria-label="Swap"
        >
          {swaps.length === 0 && <option value="">No swaps yet</option>}
          {swaps.map((s) => (
            <option key={s.id} value={s.id}>{s.title}{s.active ? '' : ' (inactive)'}</option>
          ))}
        </select>
      </div>

      {printerShown && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-400">Printer</p>
          {webTicketsOnly && mine ? (
            // Kept, not hidden: the printer is still the shop's, and is used in
            // any swap whose web isn't tickets-only. Only removable here.
            <div className="flex items-center gap-3 text-sm">
              <span className="text-gray-200">{mine.name}</span>
              <span className="text-xs text-gray-500">
                Not used in {swap?.title}: the web takes legacy tickets only.
              </span>
              {canAdmin && (
                <button
                  type="button"
                  onClick={() => assign.mutate(null)}
                  disabled={assign.isPending}
                  className="text-xs text-red-500 hover:underline ml-auto disabled:opacity-40"
                >
                  Remove
                </button>
              )}
            </div>
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
                  ? 'This seller prints labels for items without a ticket, over Bluetooth.'
                  : available.length === 0
                    ? 'No printer is free. Add one on the Printers page, or release one from its bridge.'
                    : 'Give this seller a printer to print labels for items without a ticket.'}
              </p>
            </>
          )}
        </div>
      )}

      {!printerShown && (
        <p className="text-xs text-gray-500">
          {swap?.title ?? 'This swap'} takes legacy tickets only on the web, so this seller needs no printer for it.
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
