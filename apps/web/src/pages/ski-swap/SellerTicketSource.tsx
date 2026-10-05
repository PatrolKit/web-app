import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

const numberClass =
  'w-24 bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white';

/**
 * Where this seller's tags come from, for one swap: blocks of tickets the
 * organization issued them, a printer of their own, or both (Plan 31). Issuing
 * a block creates its tickets, on sale at once (Plan 38).
 *
 * Both, because each item is one or the other, decided when it's entered: a
 * shop tags most of its stock with tickets and prints labels for the rest. The
 * swap is chosen here rather than taken from the page: tickets belong to a swap,
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
  const [notice, setNotice] = useState('');

  const { data: swaps = [] } = useQuery({
    queryKey: ['ski-swap/swaps-all', orgId],
    queryFn: () => api.skiSwap.listSwaps(orgId),
    enabled: !!orgId,
  });
  const [chosenSwapId, setChosenSwapId] = useState<string | null>(initialSwapId);
  const swap = swaps.find((s) => s.id === chosenSwapId) ?? swaps[0] ?? null;
  const swapId = swap?.id ?? null;

  const ticketsKey = ['ski-swap/issued-tickets', orgId, sellerId, swapId];
  const printersKey = ['ski-swap/printers', orgId];

  /**
   * The shop's issued tickets (Plan 38): each one an item from the moment
   * it's issued. Polled while a push to Square runs, so the progress moves.
   */
  const { data: tickets } = useQuery({
    queryKey: ticketsKey,
    queryFn: () => api.skiSwap.ticketSummary(orgId, sellerId, swapId!),
    enabled: !!swapId,
    refetchInterval: (q) => (q.state.data?.pushing ? 2000 : false),
  });

  const { data: printers = [] } = useQuery({
    queryKey: printersKey,
    queryFn: () => api.skiSwap.listPrinters(orgId),
    enabled: !!orgId,
  });

  const mine = printers.find((p) => p.assignedSellerId === sellerId) ?? null;
  const hasRanges = (tickets?.issued ?? 0) > 0;
  // Blocks are for legacy tickets anywhere: a shop's own entry on the web, or
  // at staff check-in (Plan 34).
  const legacyTicketsEnabled = !!swap && (swap.allowLegacyCheckin || swap.allowLegacyWeb);
  const webTicketsOnly = swap ? !swap.allowPrintWeb : false;

  /**
   * Issued tickets are on offer when this swap takes them. Tickets already
   * issued keep the section even when it doesn't, because a block a shop is
   * holding paper for must not vanish when somebody flips the swap setting.
   */
  const ticketsShown = legacyTicketsEnabled || hasRanges;
  /** A printer is on offer unless this swap's web takes tickets only; one already assigned stays listed. */
  const printerShown = !webTicketsOnly || !!mine;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ticketsKey });
    void qc.invalidateQueries({ queryKey: printersKey });
    // Issued tickets are items: the Items page and its counts move too.
    void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
    void qc.invalidateQueries({ queryKey: ['ski-swap/unpriced-tickets', orgId] });
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

  const span = { swapId: swapId!, startNumber: Number(from), endNumber: Number(to) };
  const spanValid = /^\d+$/.test(from) && /^\d+$/.test(to) && Number(from) <= Number(to);
  const spanCount = spanValid ? Number(to) - Number(from) + 1 : 0;

  const issue = useMutation({
    mutationFn: () => api.skiSwap.issueTickets(orgId, sellerId, span),
    onSuccess: (r) => {
      setFrom(''); setTo(''); setError('');
      setNotice(`Issued ${r.created.toLocaleString('en-US')} ticket${r.created === 1 ? '' : 's'}, ${r.startNumber}–${r.endNumber}.`);
      refresh();
    },
    onError: (e: Error) => { setNotice(''); setError(e.message); },
  });

  const takeBack = useMutation({
    mutationFn: () => api.skiSwap.removeTickets(orgId, sellerId, span),
    onSuccess: (r) => {
      setError('');
      const kept = r.kept.slice(0, 8).map((k) => `${k.sku} (${k.why})`).join(', ');
      const more = r.kept.length > 8 ? `, and ${r.kept.length - 8} more` : '';
      setNotice(
        `Removed ${r.removed.toLocaleString('en-US')}.` +
          (r.kept.length ? ` Kept ${r.kept.length}: ${kept}${more}.` : ''),
      );
      refresh();
    },
    onError: (e: Error) => { setNotice(''); setError(e.message); },
  });

  const resume = useMutation({
    mutationFn: () => api.skiSwap.pushTickets(orgId, sellerId, swapId!),
    onSuccess: () => { setError(''); refresh(); },
    onError: (e: Error) => setError(e.message),
  });

  function confirmIssue() {
    if (!confirm(`This creates ${spanCount.toLocaleString('en-US')} tickets, ${from}–${to}, and puts them on sale. Continue?`)) return;
    issue.mutate();
  }

  function confirmTakeBack() {
    if (!confirm(`Remove this shop’s unused tickets from ${from} to ${to}? Any that are described, priced or sold are kept.`)) return;
    takeBack.mutate();
  }

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
          onChange={(e) => { setChosenSwapId(e.target.value || null); setError(''); setNotice(''); }}
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
            Pre-printed tickets issued to this shop for {swap?.title}. Each one is an item from the moment
            it’s issued, on sale at whatever price the register types until it’s described.
          </p>
          {!tickets?.issued ? (
            <p className="text-xs text-gray-500">No tickets issued yet.</p>
          ) : (
            <>
              <p className="text-sm">
                <span className="font-mono text-gray-200">
                  {tickets.runs.map((r) => (r.startNumber === r.endNumber ? `${r.startNumber}` : `${r.startNumber}–${r.endNumber}`)).join(', ')}
                </span>
                <span className="text-xs text-gray-500 ml-3">
                  {tickets.issued.toLocaleString('en-US')} ticket{tickets.issued === 1 ? '' : 's'},{' '}
                  {tickets.described.toLocaleString('en-US')} described
                </span>
              </p>
              {!tickets.squareReady ? (
                <p className="text-xs text-amber-400">Square isn’t set up for this swap, so these aren’t on sale yet.</p>
              ) : tickets.pushing ? (
                <p className="text-xs text-gray-400">
                  Putting tickets in Square: {(tickets.issued - tickets.notInSquare).toLocaleString('en-US')} of{' '}
                  {tickets.issued.toLocaleString('en-US')}…
                </p>
              ) : tickets.notInSquare > 0 ? (
                <p className="text-xs text-amber-400 flex items-center gap-2">
                  {tickets.notInSquare.toLocaleString('en-US')} of these aren’t in Square yet.
                  {canAdmin && (
                    <button
                      type="button"
                      onClick={() => resume.mutate()}
                      disabled={resume.isPending}
                      className="text-xs text-brand-500 hover:underline disabled:opacity-40"
                    >
                      Put them in Square
                    </button>
                  )}
                </p>
              ) : null}
            </>
          )}

          {!legacyTicketsEnabled && (
            <p className="text-xs text-amber-400">
              This swap no longer accepts legacy tickets. These tickets still work; no
              more can be issued.
            </p>
          )}

          {canAdmin && (legacyTicketsEnabled || hasRanges) && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ''))} placeholder="from" inputMode="numeric" className={numberClass} />
              <span className="text-gray-600">–</span>
              <input value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ''))} placeholder="to" inputMode="numeric" className={numberClass} />
              {legacyTicketsEnabled && (
                <button
                  type="button"
                  onClick={confirmIssue}
                  disabled={!spanValid || issue.isPending}
                  className="text-xs px-3 py-1.5 bg-surface-100 hover:bg-surface-200 text-gray-200 rounded disabled:opacity-40"
                >
                  {issue.isPending ? 'Issuing…' : spanCount ? `Issue ${spanCount.toLocaleString('en-US')}` : 'Issue'}
                </button>
              )}
              {hasRanges && (
                <button
                  type="button"
                  onClick={confirmTakeBack}
                  disabled={!spanValid || takeBack.isPending}
                  className="text-xs px-3 py-1.5 text-red-500 hover:underline disabled:opacity-40"
                >
                  {takeBack.isPending ? 'Removing…' : 'Remove unused'}
                </button>
              )}
            </div>
          )}
          {notice && <p className="text-xs text-green-400">{notice}</p>}
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
