import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import SearchableSelect from '../../components/SearchableSelect';
import type { ItemResponse, SalesCheckDecided, SalesCheckIssue, SalesCheckOutcome, SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import { FoldHeader, SidePanel, Tombstone, useFolds } from './ReportCard';
import { centsOf } from './swapDiagnosticsView';
import {
  acceptedText, byCategory, groupsOf, missedFeesText, money, patrolKitSide, squarePriceOf, squareSide, suggestedLines, withDecided, type CategoryGroup, type SalesCheckGroup,
} from './salesCheckView';

const key = (orgId: string, swapId: string) => ['ski-swap/sales-check', orgId, swapId];

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

const btn = 'bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-2.5 py-1 rounded text-xs';
const primary = 'bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-2.5 py-1 rounded text-xs font-medium';

/**
 * Sales check (Plan 48): every sale at the swap's location that PatrolKit
 * can't put on one of its items, why, and what can be done. Looking changes
 * nothing (D13); each button is one choice, and only an admin sees them.
 */
export default function SalesCheckPage() {
  const { orgId, perms, selectedSwap: swap } = useOutletContext<SkiSwapContext>();
  if (!swap) return <p className="text-sm text-gray-400">Pick a swap to check.</p>;
  return <SalesCheck key={swap.id} orgId={orgId} swapId={swap.id} canFix={perms.has('ski_swap:admin')} />;
}

function SalesCheck({ orgId, swapId, canFix }: { orgId: string; swapId: string; canFix: boolean }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: key(orgId, swapId),
    queryFn: () => api.skiSwap.salesCheck(orgId, swapId),
    refetchInterval: 2 * 60_000,
  });
  const { data: sellers = [] } = useQuery<SellerResponse[]>({
    queryKey: ['ski-swap/sellers', orgId],
    queryFn: () => api.skiSwap.listSellers(orgId),
    enabled: canFix,
  });
  const [markSold, setMarkSold] = useState(true);
  const folds = useFolds('patrolkit:sales-check:collapsed');
  const [result, setResult] = useState<string | null>(null);
  /** After undoing an accepted sale that marked its item sold: offered here, as the undone row leaves the list. */
  const [restockOffer, setRestockOffer] = useState<{ itemId: string; label: string } | null>(null);
  const restock = useMutation({
    mutationFn: (itemId: string) => api.skiSwap.restockItem(orgId, swapId, itemId),
    onSuccess: (r) => { setRestockOffer(null); setResult(`Put back in stock: ${r.stock} in Square.`); },
  });
  const changed = () => {
    void qc.invalidateQueries({ queryKey: key(orgId, swapId) });
    void qc.invalidateQueries({ queryKey: ['ski-swap/sales-check-count', orgId, swapId] });
  };

  /**
   * Sales decided on this page, kept in place as tombstones until it reloads.
   * Square takes a few seconds to read again; until it has, these must not
   * look open (or be counted, or be accepted twice).
   */
  const [decided, setDecided] = useState<ReadonlyMap<string, Tomb>>(new Map());
  const seen = useRef(new Map<string, number>());
  const done = useMemo(() => new Set(decided.keys()), [decided]);
  const markDone = (tombs: Tomb[]) => {
    setDecided((m) => new Map([...m, ...tombs.map((t) => [t.issue.key, t] as const)]));
    changed();
  };
  const forget = (lineKey: string) => setDecided((m) => { const n = new Map(m); n.delete(lineKey); return n; });

  const shown = useMemo(() => withDecided(data?.issues ?? [], new Map([...decided].map(([k, t]) => [k, t.issue])), seen.current), [data, decided]);
  const openIssues = useMemo(() => (data?.issues ?? []).filter((i) => !done.has(i.key)), [data, done]);
  const groups = useMemo(() => groupsOf(shown, done), [shown, done]);
  const suggested = useMemo(() => suggestedLines(openIssues), [openIssues]);
  const creditAll = useMutation({
    mutationFn: () => api.skiSwap.creditSuggestedSales(orgId, swapId, { lines: suggested.map(({ orderId, lineUid, itemId }) => ({ orderId, lineUid, itemId })), markSold }),
    onSuccess: (r) => {
      const ok = r.outcomes.filter((o) => o.ok).length;
      const failed = r.outcomes.filter((o) => !o.ok);
      const byKey = new Map(openIssues.map((i) => [i.key, i]));
      markDone(r.outcomes.flatMap((o) => {
        const i = byKey.get(o.key);
        return o.ok && i?.suggestion ? [{ issue: i, text: `Accepted: ${acceptedText(i, i.suggestion, o.markedSold)}` }] : [];
      }));
      setResult(`${ok} accepted${failed.length ? `; ${failed.length} not: ${[...new Set(failed.map((f) => f.error))].join(' ')}` : ''}`);
    },
  });

  function confirmCreditAll() {
    const list = suggested.slice(0, 15).map((l) => `• ${l.label}`).join('\n');
    const more = suggested.length > 15 ? `\n…and ${suggested.length - 15} more` : '';
    if (window.confirm(`Accept ${suggested.length === 1 ? 'this suggestion' : `these ${suggested.length} suggestions`}? Each sale goes on the suggested PatrolKit item, so its seller is paid.${markSold ? ' Each item is also marked sold in Square.' : ''}\n\n${list}${more}`)) {
      creditAll.mutate();
    }
  }

  if (isLoading) return <p className="text-sm text-gray-400">Reading sales from Square…</p>;
  if (error) return <p className="text-sm text-red-400">{errorText(error)}</p>;
  if (!data) return null;
  if (data.error) return <p className="text-sm text-amber-400">Couldn’t read sales from Square: {data.error}</p>;

  const open = openIssues.length;
  const asOf = new Date(data.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="space-y-5">
      <div className="bg-surface-50 border border-gray-800 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-white font-medium">
              {open === 0 ? '✓ Every sale is on one of this swap’s items' : `${open.toLocaleString('en-US')} sale${open === 1 ? '' : 's'} to check`}
            </p>
            <p className="text-xs text-gray-500">
              Sales at the swap’s location that PatrolKit can’t put on one of its items, and fees to refund · from Square as of {asOf}
            </p>
            {missedFeesText(data.missedFees) && <p className="text-xs text-gray-500">{missedFeesText(data.missedFees)}</p>}
          </div>
          {canFix && suggested.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-400">
                <input type="checkbox" checked={markSold} onChange={(e) => setMarkSold(e.target.checked)} />
                Also mark each item sold in Square
              </label>
              <button type="button" className={primary} disabled={creditAll.isPending} onClick={confirmCreditAll}>
                {creditAll.isPending ? 'Accepting…' : suggested.length === 1 ? 'Accept the suggestion' : `Accept all ${suggested.length} suggestions`}
              </button>
            </div>
          )}
        </div>
        {groups.length > 0 && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
            {groups.filter((g) => g.open > 0).map((g) => <span key={g.kind}>{g.title}: <span className="text-gray-200">{g.open}</span> · {money(g.cents)}</span>)}
            {groups.length > 1 && (
              <button type="button" className="text-brand-500 hover:underline"
                onClick={() => folds.toggleAll(groups.map((g) => g.kind))}>
                {folds.allFolded(groups.map((g) => g.kind)) ? 'Expand all' : 'Collapse all'}
              </button>
            )}
          </p>
        )}
        {result && <p className="text-xs text-gray-300">{result}</p>}
        {restockOffer && (
          <p className="text-xs text-amber-400">
            Undone. Square still reads {restockOffer.label} as sold.{' '}
            <button type="button" className="text-brand-500 hover:underline" disabled={restock.isPending} onClick={() => restock.mutate(restockOffer.itemId)}>
              Put it back in stock
            </button>{' '}
            <button type="button" className="text-gray-400 hover:underline" onClick={() => setRestockOffer(null)}>Leave it</button>
          </p>
        )}
        {restock.error && <p className="text-xs text-red-400">{errorText(restock.error)}</p>}
        {creditAll.error && <p className="text-xs text-red-400">{errorText(creditAll.error)}</p>}
        {!canFix && open > 0 && <p className="text-xs text-gray-500">An administrator can resolve these.</p>}
      </div>

      {groups.map((g) => (
        <Group key={g.kind} group={g} orgId={orgId} swapId={swapId} canFix={canFix} sellers={sellers} markSold={markSold} decided={decided} onDone={markDone}
          collapsed={folds.isFolded(g.kind)} onToggle={() => folds.toggle(g.kind)} />
      ))}

      {data.ignoredCategories.length > 0 && (
        <div className="text-xs text-gray-500 space-x-2">
          <span>Never counted:</span>
          {data.ignoredCategories.map((c) => (
            <IgnoredCategory key={c.id} id={c.id} name={c.name} orgId={orgId} swapId={swapId} canFix={canFix}
              onChanged={() => { setDecided((m) => new Map([...m].filter(([, t]) => !(t.category && t.issue.categoryIds.includes(c.id))))); changed(); }} />
          ))}
        </div>
      )}

      {data.decided.length > 0 && (
        <details className="bg-surface-50 border border-gray-800 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm text-gray-300">Decided ({data.decided.length})</summary>
          <ul className="divide-y divide-gray-800">
            {data.decided.map((d) => (
              <Decided key={d.id} d={d} orgId={orgId} swapId={swapId} canFix={canFix}
                onUndone={(r) => { forget(d.key); if (r.markedSold && r.itemId) setRestockOffer({ itemId: r.itemId, label: d.item ? `${d.item.sku} ${d.item.name}` : 'that item' }); changed(); }} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** A sale decided on this page, and what was done. */
interface Tomb { issue: SalesCheckIssue; text: string; /** Its whole category stopped counting. */ category?: boolean }

function Group({ group, orgId, swapId, canFix, sellers, markSold, decided, onDone, collapsed, onToggle }: {
  group: SalesCheckGroup; orgId: string; swapId: string; canFix: boolean; sellers: SellerResponse[]; markSold: boolean;
  decided: ReadonlyMap<string, Tomb>; onDone: (tombs: Tomb[]) => void; collapsed: boolean; onToggle: () => void;
}) {
  const card = (i: SalesCheckIssue) => {
    const tomb = decided.get(i.key);
    return tomb ? <Tombstone key={i.key} text={tomb.text} /> : <Issue key={i.key} issue={i} orgId={orgId} swapId={swapId} canFix={canFix} sellers={sellers} markSold={markSold} onDone={onDone} />;
  };
  return (
    <section className="border border-gray-800 rounded-lg">
      <div className={`p-3 ${collapsed ? '' : 'border-b border-gray-800'}`}>
        <FoldHeader folded={collapsed} onToggle={onToggle}>
          <h4 className="text-white text-sm font-medium">
            {group.title} <span className="text-gray-500">({group.open ? `${group.open} · ${money(group.cents)}` : 'all done'})</span>
          </h4>
        </FoldHeader>
        {!collapsed && <p className="text-xs text-gray-400 mt-0.5 ml-5">{group.explain}</p>}
      </div>
      {collapsed ? null : group.kind === 'other_item' ? (
        <ul className="divide-y divide-gray-800">
          {byCategory(group.issues).map((c) => (
            <Category key={c.name} category={c} ignored={c.issues.every((i) => decided.get(i.key)?.category)} orgId={orgId} swapId={swapId} canFix={canFix} onDone={onDone}>{c.issues.map(card)}</Category>
          ))}
        </ul>
      ) : (
        <div className="p-3 space-y-3">{group.issues.map(card)}</div>
      )}
    </section>
  );
}

/** Other items: one row per Square category, its sales folded away until opened. */
function Category({ category: c, ignored, orgId, swapId, canFix, onDone, children }: {
  category: CategoryGroup; ignored: boolean; orgId: string; swapId: string; canFix: boolean; onDone: (tombs: Tomb[]) => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ignore = useMutation({
    mutationFn: (categoryId: string) => api.skiSwap.ignoreSquareCategory(orgId, swapId, { categoryId, ignore: true }),
    onSuccess: () => onDone(c.issues.map((issue) => ({ issue, text: `Not counted: “${c.name}”`, category: true }))),
  });
  if (ignored) {
    return (
      <li className="p-2">
        <Tombstone text={`“${c.name}” is no longer counted: ${c.issues.length} sale${c.issues.length === 1 ? '' : 's'}, ${money(c.issues.reduce((n, i) => n + i.collectedCents, 0))}.`} hint="Count it again below." />
      </li>
    );
  }
  const shown = c.names.slice(0, 3).join(', ') + (c.names.length > 3 ? `, +${c.names.length - 3} more` : '');
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
        <button type="button" className="flex items-center gap-2 text-left text-gray-200 hover:text-white min-w-0" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="text-gray-500 w-3">{open ? '▾' : '▸'}</span>
          <span className="font-medium">{c.name}</span>
          <span className="text-xs text-gray-500 truncate">({shown})</span>
        </button>
        <span className="text-xs text-gray-400">{c.issues.length} sale{c.issues.length === 1 ? '' : 's'} · {money(c.cents)}</span>
        {canFix && c.categoryId && (
          <button type="button" className={`${btn} ml-auto`} disabled={ignore.isPending}
            onClick={() => { if (window.confirm(`Never count sales from “${c.name}” as swap sales? They stop showing here. You can count them again below.`)) ignore.mutate(c.categoryId!); }}>
            {ignore.isPending ? 'Working…' : `Never count “${c.name}”`}
          </button>
        )}
      </div>
      {ignore.error && <p className="px-3 pb-2 text-xs text-red-400">{errorText(ignore.error)}</p>}
      {open && <div className="px-3 pb-3 space-y-3">{children}</div>}
    </li>
  );
}

type PickedItem = { id: string; sku: string; name: string; sellerName?: string | null };

function Issue({ issue, orgId, swapId, canFix, sellers, markSold, onDone }: {
  issue: SalesCheckIssue; orgId: string; swapId: string; canFix: boolean; sellers: SellerResponse[]; markSold: boolean; onDone: (tombs: Tomb[]) => void;
}) {
  const [picking, setPicking] = useState<'item' | 'seller' | null>(null);
  const [seller, setSeller] = useState('');
  /** The server said no (the sale was already decided, the item is already sold…). */
  const [refused, setRefused] = useState<string | null>(null);
  const line = { orderId: issue.orderId, lineUid: issue.lineUid };
  /** Answered: a tombstone takes the card's place at once, or the card says why not. */
  const settle = (r: SalesCheckOutcome, text: string) => {
    if (r.ok) onDone([{ issue, text }]);
    else setRefused(r.error ?? 'That didn’t work. Try again.');
  };
  const credit = useMutation({
    mutationFn: ({ item, priceCents }: { item: PickedItem; accepted: boolean; priceCents?: number }) =>
      api.skiSwap.creditSale(orgId, swapId, { ...line, itemId: item.id, markSold, ...(priceCents ? { priceCents } : {}) }),
    onMutate: () => setRefused(null),
    onSuccess: (r, { item, accepted }) => settle(r, `${accepted ? 'Accepted' : 'Done'}: ${acceptedText(issue, item, r.markedSold)}${
      r.pricedCents ? ` · priced ${money(r.pricedCents)}` : r.priceError ? ` · price not set: ${r.priceError}` : ''}`),
  });
  /** An unpriced suggestion is accepted with a price: Square's, or one asked for. */
  const unpriced = !!issue.suggestion && issue.suggestion.priceCents === null;
  const squarePrice = squarePriceOf(issue);
  const accept = (priceCents?: number) => credit.mutate({ item: { id: issue.suggestion!.itemId, ...issue.suggestion! }, accepted: true, priceCents });
  function acceptWithPrice() {
    let ask = `A price for ${issue.suggestion!.sku}, in PatrolKit and Square:`;
    for (;;) {
      const typed = window.prompt(ask, '');
      if (typed === null) return;
      const cents = centsOf(typed);
      if (cents !== null) { accept(cents); return; }
      ask = `“${typed}” isn’t a price. Enter one above $0, like 40 or 40.50:`;
    }
  }
  const notSwap = useMutation({
    mutationFn: (note?: string) => api.skiSwap.notSwapSale(orgId, swapId, { ...line, ...(note ? { note } : {}) }),
    onMutate: () => setRefused(null),
    onSuccess: (r, note) => settle(r, `Set aside: the ${money(issue.collectedCents)} sale isn’t a swap sale${note ? ` (“${note}”)` : ''}.`),
  });
  const issue_ = useMutation({
    mutationFn: () => api.skiSwap.issueAndCreditSale(orgId, swapId, { ...line, sellerId: seller, ticket: issue.ticket! }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => settle(r, `Issued ${issue.ticket} to ${sellers.find((s) => s.id === seller)?.displayName ?? 'the seller'}, and put the ${money(issue.collectedCents)} sale on it.`),
  });
  const feeHandled = useMutation({
    mutationFn: () => api.skiSwap.feeHandled(orgId, swapId, { orderId: issue.orderId }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => settle(r, `Marked refunded: ${money(issue.fee?.refundCents ?? issue.collectedCents)} ${issue.fee?.shopFeeName ?? 'fee'}.`),
  });
  const busy = credit.isPending || notSwap.isPending || issue_.isPending || feeHandled.isPending;
  const failed = credit.error ?? notSwap.error ?? issue_.error ?? feeHandled.error;
  const err = refused ?? (failed ? errorText(failed) : null);
  const when = new Date(issue.soldAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className={`border border-gray-800 rounded-lg overflow-hidden bg-surface-50 transition-opacity ${busy ? 'opacity-60' : ''}`} aria-busy={busy}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1.75rem_minmax(0,1fr)]">
        <SidePanel side={squareSide(issue)} icon="■" />
        <div className="hidden md:flex items-center justify-center text-gray-600">→</div>
        <SidePanel side={patrolKitSide(issue)} icon="◆" className="border-t md:border-t-0 md:border-l border-gray-800" />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-gray-800 bg-surface-100/40">
        <span className="text-xs text-gray-500 mr-auto">{when}</span>
        {err && <span className="text-xs text-red-400">{err}</span>}
        {canFix && issue.fee && (
          <button type="button" className={btn} disabled={busy}
            onClick={() => { if (window.confirm(`Mark this ${issue.fee!.shopFeeName} refunded? Only when it was refunded some way Square doesn’t show; a refund in Square clears it by itself.`)) feeHandled.mutate(); }}>
            Mark refunded…
          </button>
        )}
        {canFix && issue.kind !== 'oversold' && !issue.fee && (
          <>
            <button type="button" className={btn} disabled={busy}
              onClick={() => { const note = window.prompt('Not a swap sale. A note, if you like (e.g. “swag”):', ''); if (note !== null) notSwap.mutate(note.trim() || undefined); }}>
              Not a swap sale
            </button>
            <button type="button" className={btn} disabled={busy} onClick={() => setPicking(picking === 'item' ? null : 'item')}>
              Pick {issue.suggestion ? 'another' : 'an'} item…
            </button>
            {issue.kind === 'unknown_ticket' && (
              <button type="button" className={btn} disabled={busy} onClick={() => setPicking(picking === 'seller' ? null : 'seller')}>Issue to a seller…</button>
            )}
            {issue.suggestion && unpriced && (
              <>
                <button type="button" className={btn} disabled={busy} onClick={acceptWithPrice}>Accept with different price…</button>
                {squarePrice !== null && (
                  <button type="button" className={primary} disabled={busy} onClick={() => accept(squarePrice)}>
                    {credit.isPending ? 'Accepting…' : `Accept with Square price (${money(squarePrice)})`}
                  </button>
                )}
              </>
            )}
            {issue.suggestion && !unpriced && (
              <button type="button" className={primary} disabled={busy} onClick={() => accept()}>
                {credit.isPending ? 'Accepting…' : 'Accept suggestion'}
              </button>
            )}
          </>
        )}
      </div>

      {picking === 'item' && <div className="px-3 pb-3"><ItemPicker orgId={orgId} swapId={swapId}
        onPick={(it) => { setPicking(null); credit.mutate({ item: { id: it.id, sku: it.sku, name: it.name, sellerName: it.seller?.displayName ?? null }, accepted: false }); }} /></div>}
      {picking === 'seller' && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          <div className="w-64">
            <SearchableSelect value={seller} onChange={setSeller} placeholder="Whose ticket is it?" clearLabel="No seller chosen"
              options={sellers.map((s) => ({ value: s.id, label: s.displayName, sublabel: s.phone ?? undefined, keywords: s.email ?? undefined }))} />
          </div>
          <button type="button" className={primary} disabled={!seller || busy}
            onClick={() => { if (window.confirm(`Issue ticket ${issue.ticket} to this seller, put it in Square, and put this sale on it?`)) issue_.mutate(); }}>
            Issue {issue.ticket} and use it
          </button>
        </div>
      )}
    </div>
  );
}

/** "Pick another item…": the Items search, by ticket or name. */
function ItemPicker({ orgId, swapId, onPick }: { orgId: string; swapId: string; onPick: (item: ItemResponse) => void }) {
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['ski-swap/sales-check-search', orgId, swapId, q],
    queryFn: () => api.skiSwap.listItems(orgId, swapId, { query: q, take: 8 }),
    enabled: q.trim().length >= 2,
  });
  return (
    <div className="space-y-1">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticket number or name…"
        className="w-64 bg-surface-100 px-3 py-1.5 rounded text-sm text-white" />
      {data?.items.map((it) => (
        <button key={it.id} type="button" onClick={() => onPick(it)}
          className="block text-left text-xs text-gray-300 hover:text-white">
          <span className="font-mono text-brand-400">{it.sku}</span> {it.name} · {it.priceCents === null ? 'unpriced' : money(it.priceCents)}
          {it.seller ? ` · ${it.seller.displayName}` : ''}
        </button>
      ))}
    </div>
  );
}

function Decided({ d, orgId, swapId, canFix, onUndone }: {
  d: SalesCheckDecided; orgId: string; swapId: string; canFix: boolean;
  onUndone: (r: { markedSold: boolean; itemId: string | null }) => void;
}) {
  const undo = useMutation({ mutationFn: () => api.skiSwap.undoSaleDecision(orgId, swapId, d.id), onSuccess: onUndone });
  const when = new Date(d.decidedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <li className="px-4 py-2 text-xs text-gray-400 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-gray-200">
        {d.decision === 'CREDIT' ? `${money(d.collectedCents)} sale put on ${d.item ? `${d.item.sku} ${d.item.name}` : 'an item'}`
          : d.decision === 'FEE_HANDLED' ? `${money(d.collectedCents)} fee marked refunded`
            : `Not a swap sale (${money(d.collectedCents)})`}
      </span>
      {d.note && <span>“{d.note}”</span>}
      {d.markedSold && <span>marked sold in Square</span>}
      <span>{d.decidedBy ? `${d.decidedBy}, ` : ''}{when}</span>
      {d.links.sale && <a href={d.links.sale} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">Sale ↗</a>}
      {canFix && (
        <button type="button" className="text-brand-500 hover:underline disabled:opacity-40" disabled={undo.isPending}
          onClick={() => { if (window.confirm('Undo this? The sale goes back on the list.')) undo.mutate(); }}>Undo</button>
      )}
      {undo.error && <span className="text-red-400">{errorText(undo.error)}</span>}
    </li>
  );
}

function IgnoredCategory({ id, name, orgId, swapId, canFix, onChanged }: { id: string; name: string; orgId: string; swapId: string; canFix: boolean; onChanged: () => void }) {
  const count = useMutation({ mutationFn: () => api.skiSwap.ignoreSquareCategory(orgId, swapId, { categoryId: id, ignore: false }), onSuccess: onChanged });
  return (
    <span className="inline-flex items-center gap-1 bg-surface-100 rounded px-2 py-0.5 text-gray-300">
      {name}
      {canFix && <button type="button" className="text-brand-500 hover:underline" disabled={count.isPending} onClick={() => count.mutate()}>count again</button>}
    </span>
  );
}
