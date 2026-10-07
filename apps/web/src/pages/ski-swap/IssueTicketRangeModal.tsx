import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SellerResponse, SwapResponse } from '../../lib/api.types';

const inputClass = 'w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white font-mono';

/** A block this big asks again: a slipped digit makes thousands of items. */
const LARGE_BLOCK = 1000;

/** "67000–67499, 68000" */
/** Sellers holding tickets, for a searchable picker: by name, with their ranges beside it. */
export function ticketSellerOptions(sellers: { sellerId: string; displayName: string; ranges: { startNumber: number; endNumber: number }[] }[]) {
  return sellers.map((s) => ({
    value: s.sellerId,
    label: s.displayName,
    ...(s.ranges.length ? { sublabel: runsText(s.ranges) } : {}),
  }));
}

export function runsText(runs: { startNumber: number; endNumber: number }[]): string {
  return runs.map((r) => (r.startNumber === r.endNumber ? `${r.startNumber}` : `${r.startNumber}–${r.endNumber}`)).join(', ');
}

/**
 * Issue a block of pre-printed tickets to a seller (Plan 38): every number
 * from the first to the last, both included, becomes an item on sale at once.
 * A shop fills its tickets in from its own desk; an individual's page has no
 * such desk, so staff fill theirs in (Fast Edit), and the popover says so.
 *
 * Only swaps that take legacy tickets are offered, newest first, and the newest
 * is chosen. The Sellers list shows the action only when there is one.
 */
export default function IssueTicketRangeModal({ orgId, seller, swaps, onClose }: {
  orgId: string;
  seller: SellerResponse;
  /** Active swaps that take legacy tickets, newest first. */
  swaps: SwapResponse[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [swapId, setSwapId] = useState(swaps[0]?.id ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const summaryKey = ['ski-swap/issued-tickets', orgId, seller.id, swapId];
  /** What the shop already holds here, and, after issuing, Square's progress. */
  const { data: tickets } = useQuery({
    queryKey: summaryKey,
    queryFn: () => api.skiSwap.ticketSummary(orgId, seller.id, swapId),
    enabled: !!swapId,
    refetchInterval: (q) => (q.state.data?.pushing ? 2000 : false),
  });

  const valid = /^\d+$/.test(from) && /^\d+$/.test(to) && Number(from) <= Number(to);
  const count = valid ? Number(to) - Number(from) + 1 : 0;
  const countText = count.toLocaleString('en-US');

  const issue = useMutation({
    mutationFn: () => api.skiSwap.issueTickets(orgId, seller.id, {
      swapId, startNumber: Number(from), endNumber: Number(to),
    }),
    onSuccess: (r) => {
      setFrom(''); setTo(''); setError('');
      setNotice(`Issued ${r.created.toLocaleString('en-US')} ticket${r.created === 1 ? '' : 's'}, ${r.startNumber}–${r.endNumber}.`);
      void qc.invalidateQueries({ queryKey: summaryKey });
      // Issued tickets are items: the Items page and its counts move too.
      void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
      void qc.invalidateQueries({ queryKey: ['ski-swap/unpriced-tickets', orgId] });
      void qc.invalidateQueries({ queryKey: ['ski-swap/ticket-push', orgId] });
    },
    onError: (e: Error) => { setNotice(''); setError(e.message); },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || issue.isPending) return;
    if (count >= LARGE_BLOCK && !confirm(`That's ${countText} tickets, ${from}–${to}. Issue them all?`)) return;
    issue.mutate();
  }

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
          <h3 className="text-white font-medium">Issue Ticket Range</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-white text-lg leading-none">×</button>
        </div>

        <div className="space-y-1">
          <p className="text-white text-sm font-medium">{seller.displayName}</p>
          {swaps.length > 1 ? (
            <select
              value={swapId}
              onChange={(e) => { setSwapId(e.target.value); setError(''); setNotice(''); }}
              aria-label="Swap"
              className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white"
            >
              {swaps.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
          ) : (
            <p className="text-gray-500 text-xs">{swaps[0]?.title}</p>
          )}
          <p className="text-xs text-gray-500">
            {tickets?.issued
              ? <>Already holds <span className="font-mono text-gray-300">{runsText(tickets.runs)}</span> ({tickets.issued.toLocaleString('en-US')}).</>
              : 'No tickets issued yet.'}
          </p>
          {!seller.businessName && (
            <p className="text-xs text-amber-400/90">
              An individual can’t fill in tickets online: staff price and describe them, in Fast Edit.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-gray-400 mb-1 block">First ticket</span>
            <input
              autoFocus value={from} inputMode="numeric" className={inputClass}
              onChange={(e) => { setFrom(e.target.value.replace(/\D/g, '')); setNotice(''); }}
            />
          </label>
          <label className="block">
            <span className="text-xs text-gray-400 mb-1 block">Last ticket</span>
            <input
              value={to} inputMode="numeric" className={inputClass}
              onChange={(e) => { setTo(e.target.value.replace(/\D/g, '')); setNotice(''); }}
            />
          </label>
        </div>

        <p className="text-xs text-gray-500 min-h-4">
          {valid
            ? `Creates ${countText} ticket${count === 1 ? '' : 's'}, ${from} through ${to}, on sale at once.`
            : from && to ? 'The last ticket comes before the first.' : 'Both numbers are included.'}
        </p>

        <button
          type="submit"
          disabled={!valid || issue.isPending}
          className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white py-2 rounded text-sm font-medium"
        >
          {issue.isPending ? 'Issuing…' : valid ? `Issue ${countText} Ticket${count === 1 ? '' : 's'}` : 'Issue Tickets'}
        </button>

        {notice && <p className="text-xs text-green-400">{notice}</p>}
        {error && <p className="text-xs text-red-400">{error}</p>}
        {notice && tickets && (
          !tickets.squareReady ? (
            <p className="text-xs text-amber-400">Square isn’t set up for this swap, so these aren’t on sale yet.</p>
          ) : tickets.pushing ? (
            <p className="text-xs text-gray-400">
              Putting tickets in Square: {(tickets.issued - tickets.notInSquare).toLocaleString('en-US')} of{' '}
              {tickets.issued.toLocaleString('en-US')}…
            </p>
          ) : tickets.notInSquare > 0 ? (
            <p className="text-xs text-amber-400">
              {tickets.notInSquare.toLocaleString('en-US')} aren’t in Square yet. Finish from the Items page’s Actions.
            </p>
          ) : (
            <p className="text-xs text-gray-400">All in Square.</p>
          )
        )}
      </form>
    </div>
  );
}
