import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

const numberClass =
  'w-24 bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white';

/**
 * Where this seller's tags come from, for one swap: blocks of tickets the
 * organization issued them, a printer of their own, or both (Plan 31).
 *
 * Both, because each item is one or the other, decided when it's entered: a
 * shop tags most of its stock with tickets and prints labels for the rest. The
 * swap is chosen here rather than taken from the page: ranges belong to a swap,
 * and so does whether the web may use a printer at all (its "Web UI: legacy
 * tickets only" setting). The printer itself is the seller's across swaps.
 *
 * Assignment lives here rather than on the Printers page: it is a fact about
 * the seller, beside the other answer to the same question.
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
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');

  const { data: swaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps-all', orgId],
    queryFn: () => api.skiSwap.listSwaps(orgId),
    enabled: !!orgId,
  });
  const [chosenSwapId, setChosenSwapId] = useState<string | null>(initialSwapId);
  const swap = swaps.find((s) => s.id === chosenSwapId) ?? swaps[0] ?? null;
  const swapId = swap?.id ?? null;

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
  // Blocks are for legacy tickets anywhere: a shop's own entry on the web, or
  // at staff check-in (Plan 34).
  const legacyTicketsEnabled = !!swap && (swap.allowLegacyCheckin || swap.allowLegacyWeb);
  const webTicketsOnly = swap ? !swap.allowPrintWeb : false;

  /**
   * Issued tickets are on offer when this swap takes them. Ranges already
   * issued keep the section even when it doesn't, because a block a shop is
   * holding paper for must not vanish when somebody flips the swap setting.
   */
  const ticketsShown = legacyTicketsEnabled || hasRanges;
  /** A printer is on offer unless this swap's web takes tickets only; one already assigned stays listed. */
  const printerShown = !webTicketsOnly || !!mine;

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
    <div className="space-y-3 pt-1 border-t border-gray-700">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider shrink-0">Tags for</p>
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

      {ticketsShown && swapId && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-400">Issued Tickets</p>
          <p className="text-xs text-gray-500">
            Blocks of pre-printed tickets issued to this shop for {swap?.title}.
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

          {!legacyTicketsEnabled && (
            <p className="text-xs text-amber-400">
              This swap no longer accepts legacy tickets. These blocks still work; no
              more can be issued.
            </p>
          )}

          {canAdmin && legacyTicketsEnabled && (
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
        </div>
      )}

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

      {!ticketsShown && !printerShown && (
        <p className="text-xs text-gray-500">
          {swap?.title ?? 'This swap'} takes legacy tickets only on the web, and doesn't accept them yet.
        </p>
      )}

      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
