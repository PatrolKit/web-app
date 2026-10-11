import { useMemo, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { ExchangeItem, ExchangeLookupLine, ItemResponse, RecordExchangeResponse, SwapExchangeResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import { NoteBox, SidePanel, Tombstone } from './ReportCard';
import { itemState } from './SwapItemsPanel';
import { centsOf } from './swapDiagnosticsView';
import { money } from './salesCheckView';
import {
  comingBackSide, differenceShort, differenceText, goingOutSide, lookupQuery, matches, recordedText, sellerWarning, statusOf,
} from './exchangesView';

const listKey = (orgId: string, swapId: string) => ['ski-swap/exchanges', orgId, swapId];

const btn = 'bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-2.5 py-1 rounded text-xs';
const primary = 'bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-3 py-1.5 rounded text-sm font-medium';
const input = 'bg-surface-100 border border-gray-700 focus:border-brand-500 rounded px-3 py-1.5 text-sm text-white';

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Exchanges (Plan 49): a customer handed back an item they bought and left
 * with another. An admin records it at the counter; everyone with report
 * access sees the list.
 */
export default function ExchangesPage() {
  const { orgId, perms, selectedSwap: swap } = useOutletContext<SkiSwapContext>();
  if (!swap) return <p className="text-sm text-gray-400">Pick a swap.</p>;
  return <Exchanges key={swap.id} orgId={orgId} swapId={swap.id} isAdmin={perms.has('ski_swap:admin')} />;
}

function Exchanges({ orgId, swapId, isAdmin }: { orgId: string; swapId: string; isAdmin: boolean }) {
  return (
    <div className="space-y-5">
      <p className="text-sm text-gray-300 bg-sky-950/30 border border-sky-800/60 rounded-lg px-4 py-3">
        Exchanges in Square are preferred, but they need Square Plus and the Square for Retail POS app.
        Record an exchange here when Square can’t.
      </p>
      {isAdmin && <RecordPanel orgId={orgId} swapId={swapId} />}
      <ExchangeList orgId={orgId} swapId={swapId} isAdmin={isAdmin} />
    </div>
  );
}

// ─── Record an exchange ──────────────────────────────────────────────────────

function RecordPanel({ orgId, swapId }: { orgId: string; swapId: string }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [typed, setTyped] = useState(() => params.get('ticket') ?? '');
  const [query, setQuery] = useState<{ receipt?: string; ticket?: string } | null>(() => lookupQuery(params.get('ticket') ?? ''));
  const [line, setLine] = useState<ExchangeLookupLine | null>(null);
  const [out, setOut] = useState<ExchangeItem | null>(null);
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<{ text: string; result: RecordExchangeResponse } | null>(null);

  const lookup = useQuery({
    queryKey: ['ski-swap/exchange-lookup', orgId, swapId, query],
    queryFn: () => api.skiSwap.exchangeLookup(orgId, swapId, query!),
    enabled: !!query,
    staleTime: 0,
  });

  const record = useMutation({
    mutationFn: () => api.skiSwap.recordExchange(orgId, swapId, {
      orderId: line!.orderId, lineUid: line!.lineUid, returnedItemId: line!.item.id, replacementItemId: out!.id,
      ...(out!.priceCents === null ? { priceCents: centsOf(price) ?? undefined } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    }),
    onSuccess: (r) => {
      setDone({ text: recordedText(line!, out!), result: r });
      void qc.invalidateQueries({ queryKey: listKey(orgId, swapId) });
      void qc.invalidateQueries({ queryKey: ['ski-swap/sales-check', orgId, swapId] });
    },
  });

  function find() {
    const q = lookupQuery(typed);
    setLine(null); setOut(null); setPrice(''); setDone(null); record.reset();
    setQuery(q);
    if (params.has('ticket')) { params.delete('ticket'); setParams(params, { replace: true }); }
  }

  function startOver() {
    setTyped(''); setQuery(null); setLine(null); setOut(null); setPrice(''); setNote(''); setDone(null); record.reset();
    if (params.has('ticket')) { params.delete('ticket'); setParams(params, { replace: true }); }
  }

  const unpriced = out?.priceCents === null;
  const priceCents = unpriced ? centsOf(price) : out?.priceCents ?? null;
  const difference = line && out && line.item.priceCents !== null && priceCents !== null ? priceCents - line.item.priceCents : null;
  const typedBad = typed.trim() !== '' && !lookupQuery(typed);

  return (
    <section className="bg-surface-50 border border-gray-800 rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-white font-medium">Record an exchange</h3>
        <p className="text-xs text-gray-500">
          Find the sale, pick the item the customer is leaving with, and record it. The item coming back goes back on sale in Square,
          and the one going out is marked sold. No money changes hands.
        </p>
      </div>

      {done ? (
        <div className="space-y-2">
          <Tombstone text={done.text} hint="" />
          {done.result.pricedCents !== null && <p className="text-xs text-gray-400">{out?.sku} priced at {money(done.result.pricedCents)}.</p>}
          {done.result.stockError && (
            <p className="text-xs text-amber-400">
              Saved, but Square’s stock wasn’t updated: {done.result.stockError} Use Retry on the exchange below.
            </p>
          )}
          <button type="button" className={btn} onClick={startOver}>Record another</button>
        </div>
      ) : (
        <>
          {/* 1. Find the sale */}
          <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); find(); }}>
            <label htmlFor="exchange-find" className="text-sm text-gray-300">Receipt # or the ticket coming back</label>
            <input id="exchange-find" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Receipt # or SKU" className={`${input} w-44 font-mono`} />
            <button type="submit" className={btn} disabled={!lookupQuery(typed) || lookup.isFetching}>{lookup.isFetching ? 'Finding…' : 'Find'}</button>
            {typedBad && <span className="text-xs text-amber-400">A receipt is 4 letters and digits; a ticket is its number.</span>}
          </form>

          {query && !line && <LookupResults lookup={lookup} onPick={(l) => { setLine(l); setOut(null); setPrice(''); }} />}

          {/* 2. The card: coming back → going out */}
          {line && (
            <div className="space-y-3">
              <div className={`border border-gray-800 rounded-lg bg-surface-50 ${record.isPending ? 'opacity-60' : ''}`}>
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1.75rem_minmax(0,1fr)]">
                  <SidePanel side={comingBackSide(line)} icon="↩" action={<button type="button" className="text-xs text-brand-500 hover:underline" onClick={() => { setLine(null); setOut(null); }}>Pick another sale</button>} />
                  <div className="hidden md:flex items-center justify-center text-gray-600">→</div>
                  <SidePanel side={goingOutSide(out)} icon="↪" className="border-t md:border-t-0 md:border-l border-gray-800"
                    action={<ItemPicker orgId={orgId} swapId={swapId} exclude={line.item.id} picked={!!out} onPick={(it) => { setOut(it); setPrice(''); }} />} />
                </div>
              </div>

              {line.exchange && (
                <p className="text-xs text-sky-300">This sale was already exchanged ({line.exchange.returnedSku} for {line.item.sku}). Recording this replaces that exchange.</p>
              )}

              {out && (
                <div className="space-y-2 text-sm">
                  {sellerWarning(line.item, out) && <p className="text-amber-400">{sellerWarning(line.item, out)}</p>}
                  {unpriced && (
                    <p className="flex flex-wrap items-center gap-2">
                      <label htmlFor="exchange-price" className="text-amber-400">{out.sku} has no price yet. Its seller is paid it, so give it one:</label>
                      <input id="exchange-price" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="$" inputMode="decimal" className={`${input} w-24`} />
                    </p>
                  )}
                  {differenceText(difference) && (
                    <p className={difference ? 'text-amber-300' : 'text-gray-400'}>
                      {differenceText(difference)}
                      {difference ? ' For a big difference, refund the sale and ring up the new item in Square instead.' : ''}
                    </p>
                  )}
                  {line.paidInRun && (
                    <p className="text-amber-400">
                      A payout run ({line.paidInRun.status.toLowerCase()}) already paid {line.item.sellerName ?? 'the seller'} for {line.item.sku} on this sale.
                      Recording the exchange doesn’t change that run: settle the difference by hand.
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional): why, who helped…" className={`${input} flex-1 min-w-[16rem]`} />
                    <button type="button" className={primary} disabled={record.isPending || (unpriced && priceCents === null)} onClick={() => record.mutate()}>
                      {record.isPending ? 'Recording…' : 'Record exchange'}
                    </button>
                  </div>
                  {record.error && <p className="text-xs text-red-400">{errorText(record.error)}</p>}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function LookupResults({ lookup, onPick }: {
  lookup: { data?: { lines: ExchangeLookupLine[]; error: string | null }; isLoading: boolean; error: unknown };
  onPick: (l: ExchangeLookupLine) => void;
}) {
  if (lookup.isLoading) return <p className="text-xs text-gray-400">Reading sales from Square…</p>;
  if (lookup.error) return <p className="text-xs text-red-400">{errorText(lookup.error)}</p>;
  if (lookup.data?.error) return <p className="text-xs text-amber-400">Couldn’t read sales from Square: {lookup.data.error}</p>;
  const lines = lookup.data?.lines ?? [];
  if (lines.length === 0) {
    return <p className="text-xs text-gray-400">No sale of this swap’s items matches. Check the receipt number, or try the ticket coming back.</p>;
  }
  return (
    <div className="space-y-1">
      <p className="text-xs text-gray-500">{lines.length === 1 ? 'Is this the sale?' : 'Which of these is coming back?'}</p>
      <ul className="border border-gray-800 rounded-lg divide-y divide-gray-800">
        {lines.map((l) => (
          <li key={`${l.orderId}:${l.lineUid}`}>
            <button type="button" onClick={() => onPick(l)} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-100 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-mono text-brand-400">{l.item.sku}</span>
              <span className="text-gray-200">{l.item.name}</span>
              <span className="text-xs text-gray-400">{l.item.sellerName ?? 'No seller'} · {l.item.priceCents === null ? 'unpriced' : money(l.item.priceCents)}</span>
              <span className="text-xs text-gray-500 ml-auto">{l.receipt ? `#${l.receipt} · ` : ''}{when(l.soldAt)}</span>
              {l.exchange && <span className="text-[11px] bg-sky-900/40 text-sky-300 rounded px-1.5 py-px">exchanged from {l.exchange.returnedSku}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The item going out: the Items search, by ticket or name, for sale only. */
function ItemPicker({ orgId, swapId, exclude, picked, onPick }: {
  orgId: string; swapId: string; exclude: string; picked: boolean; onPick: (item: ExchangeItem) => void;
}) {
  const [open, setOpen] = useState(!picked);
  const [q, setQ] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['ski-swap/exchange-search', orgId, swapId, q],
    queryFn: () => api.skiSwap.listItems(orgId, swapId, { query: q, take: 12 }),
    enabled: open && q.trim().length >= 2,
  });
  const forSale = useMemo(() => (data?.items ?? []).filter((it) => it.id !== exclude && itemState(it).key === 'for_sale'), [data, exclude]);
  const others = (data?.items.length ?? 0) - forSale.length;
  if (!open) return <button type="button" className="text-xs text-brand-500 hover:underline" onClick={() => setOpen(true)}>Pick another item</button>;
  const pick = (it: ItemResponse) => {
    onPick({ id: it.id, sku: it.sku, name: it.name, priceCents: it.priceCents, sellerId: it.seller?.id ?? null, sellerName: it.seller?.displayName ?? null, deleted: false });
    setOpen(false);
  };
  return (
    <div className="space-y-1">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticket number or name…" className={`${input} w-full`} />
      {forSale.map((it) => (
        <button key={it.id} type="button" onClick={() => pick(it)} className="block w-full text-left text-xs text-gray-300 hover:text-white">
          <span className="font-mono text-brand-400">{it.sku}</span> {it.name} · {it.priceCents === null ? 'unpriced' : money(it.priceCents)}
          {it.seller ? ` · ${it.seller.displayName}` : ''}
        </button>
      ))}
      {q.trim().length >= 2 && !isFetching && forSale.length === 0 && (
        <p className="text-xs text-gray-500">{others > 0 ? 'Nothing that matches is for sale.' : 'No item matches.'}</p>
      )}
    </div>
  );
}

// ─── Exchanges so far ────────────────────────────────────────────────────────

function ExchangeList({ orgId, swapId, isAdmin }: { orgId: string; swapId: string; isAdmin: boolean }) {
  const { data, isLoading, error } = useQuery({
    queryKey: listKey(orgId, swapId),
    queryFn: () => api.skiSwap.exchanges(orgId, swapId),
  });
  const [q, setQ] = useState('');
  const shown = useMemo(() => (data?.exchanges ?? []).filter((e) => matches(e, q)), [data, q]);

  if (isLoading) return <p className="text-sm text-gray-400">Loading exchanges…</p>;
  if (error) return <p className="text-sm text-red-400">{errorText(error)}</p>;
  if (!data) return null;
  const { totals } = data;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-white font-medium">Exchanges so far</h3>
        <span className="text-xs text-gray-400">
          {totals.live} live
          {totals.absorbedCents > 0 && <> · patrol absorbed <span className="text-gray-200">{money(totals.absorbedCents)}</span></>}
          {totals.keptCents > 0 && <> · patrol kept <span className="text-gray-200">{money(totals.keptCents)}</span></>}
        </span>
        {data.exchanges.length > 0 && (
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ticket, receipt or seller" className={`${input} ml-auto w-64`} />
        )}
      </div>
      {data.exchanges.length === 0 ? (
        <p className="text-sm text-gray-500">No exchanges yet.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-gray-500">No exchange matches “{q}”.</p>
      ) : (
        <div className="space-y-3">
          {shown.map((e) => <ExchangeCard key={e.id} e={e} orgId={orgId} swapId={swapId} isAdmin={isAdmin} />)}
        </div>
      )}
    </section>
  );
}

function ExchangeCard({ e, orgId, swapId, isAdmin }: { e: SwapExchangeResponse; orgId: string; swapId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const changed = () => {
    void qc.invalidateQueries({ queryKey: listKey(orgId, swapId) });
    void qc.invalidateQueries({ queryKey: ['ski-swap/sales-check', orgId, swapId] });
  };
  const cancel = useMutation({ mutationFn: (reason: string) => api.skiSwap.cancelExchange(orgId, swapId, e.id, reason), onSuccess: changed });
  const retry = useMutation({ mutationFn: () => api.skiSwap.retryExchangeStock(orgId, swapId, e.id), onSuccess: changed });
  const status = statusOf(e);
  const live = e.status === 'live';
  const busy = cancel.isPending || retry.isPending;
  const failed = cancel.error ?? retry.error;

  function askCancel() {
    const reason = window.prompt(`Cancel this exchange? ${e.returned.sku} is marked sold again and ${e.replacement.sku} goes back on sale in Square. Why?`, '');
    if (reason === null) return;
    if (!reason.trim()) { window.alert('Say why, so whoever looks later knows.'); return; }
    cancel.mutate(reason.trim());
  }

  const item = (i: ExchangeItem, cents: number | null) => (
    <span className="min-w-0">
      <span className="font-mono text-brand-400">{i.sku}</span> <span className="text-gray-200">{i.name}</span>
      <span className="text-xs text-gray-400"> · {i.sellerName ?? 'No seller'} · {cents === null ? 'unpriced' : money(cents)}</span>
    </span>
  );

  return (
    <div className={`border border-gray-800 rounded-lg bg-surface-50 ${live ? '' : 'opacity-70'} ${busy ? 'opacity-60' : ''}`} aria-busy={busy}>
      <div className="p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className={`rounded px-1.5 py-px ${status.tone}`}>{status.label}</span>
          {e.receipt && <span className="font-mono text-gray-300">#{e.receipt}</span>}
          {e.links.sale && <a href={e.links.sale} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">Sale in Square ↗</a>}
          <span className="text-gray-500 ml-auto">{e.recordedByName ?? 'Someone'}, {when(e.recordedAt)}</span>
        </div>
        <dl className="grid grid-cols-[5rem_1fr] gap-x-2 gap-y-0.5 text-sm">
          <dt className="text-xs text-gray-500 pt-0.5">Came back</dt><dd className="min-w-0">{item(e.returned, e.returnedPriceCents)}</dd>
          <dt className="text-xs text-gray-500 pt-0.5">Went out</dt><dd className="min-w-0">{item(e.replacement, e.replacementPriceCents)}</dd>
        </dl>
        {/* What the patrol absorbed or kept: only while the exchange stands. */}
        {live && differenceShort(e.differenceCents) && <p className="text-xs text-gray-400">{differenceShort(e.differenceCents)}</p>}
        {e.status === 'cancelled' && (
          <p className="text-xs text-gray-400">Cancelled by {e.cancelledByName ?? 'someone'}{e.cancelledAt ? `, ${when(e.cancelledAt)}` : ''}{e.cancelReason ? `: “${e.cancelReason}”` : ''}</p>
        )}
        <NoteBox canEdit={isAdmin}
          note={e.note ? { text: e.note, updatedByName: e.recordedByName, updatedAt: e.recordedAt } : null}
          onSave={async (text) => { await api.skiSwap.editExchangeNote(orgId, swapId, e.id, text); changed(); }} />
      </div>
      {isAdmin && live && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-gray-800 bg-surface-100/40 rounded-b-lg">
          {failed && <span className="text-xs text-red-400 mr-auto">{errorText(failed)}</span>}
          {!e.stockSynced && (
            <button type="button" className={btn} disabled={busy} onClick={() => retry.mutate()}>{retry.isPending ? 'Retrying…' : 'Retry stock'}</button>
          )}
          <button type="button" className={`${btn} ml-auto`} disabled={busy} onClick={askCancel}>{cancel.isPending ? 'Cancelling…' : 'Cancel…'}</button>
        </div>
      )}
    </div>
  );
}
