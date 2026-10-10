import { useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import SearchableSelect from '../../components/SearchableSelect';
import type { SalesCheckDecided, SalesCheckIssue, SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import { groupsOf, money, sentence, suggestedLines, type SalesCheckGroup } from './salesCheckView';

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
  return <SalesCheck orgId={orgId} swapId={swap.id} canFix={perms.has('ski_swap:admin')} />;
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
  const [result, setResult] = useState<string | null>(null);
  /** After undoing a credit that marked its item sold: offered here, as the undone row leaves the list. */
  const [restockOffer, setRestockOffer] = useState<{ itemId: string; label: string } | null>(null);
  const restock = useMutation({
    mutationFn: (itemId: string) => api.skiSwap.restockItem(orgId, swapId, itemId),
    onSuccess: (r) => { setRestockOffer(null); setResult(`Put back in stock: ${r.stock} in Square.`); },
  });
  const changed = () => {
    void qc.invalidateQueries({ queryKey: key(orgId, swapId) });
    void qc.invalidateQueries({ queryKey: ['ski-swap/sales-check-count', orgId, swapId] });
  };

  const groups = useMemo(() => groupsOf(data?.issues ?? []), [data]);
  const suggested = useMemo(() => suggestedLines(data?.issues ?? []), [data]);
  const creditAll = useMutation({
    mutationFn: () => api.skiSwap.creditSuggestedSales(orgId, swapId, { lines: suggested.map(({ orderId, lineUid, itemId }) => ({ orderId, lineUid, itemId })), markSold }),
    onSuccess: (r) => {
      const ok = r.outcomes.filter((o) => o.ok).length;
      const failed = r.outcomes.filter((o) => !o.ok);
      setResult(`${ok} credited${failed.length ? `; ${failed.length} not: ${[...new Set(failed.map((f) => f.error))].join(' ')}` : ''}`);
      changed();
    },
  });

  function confirmCreditAll() {
    const list = suggested.slice(0, 15).map((l) => `• ${l.label}`).join('\n');
    const more = suggested.length > 15 ? `\n…and ${suggested.length - 15} more` : '';
    if (window.confirm(`Credit these ${suggested.length} sales to the tickets suggested?${markSold ? ' Each item is also marked sold in Square.' : ''}\n\n${list}${more}`)) {
      creditAll.mutate();
    }
  }

  if (isLoading) return <p className="text-sm text-gray-400">Reading sales from Square…</p>;
  if (error) return <p className="text-sm text-red-400">{errorText(error)}</p>;
  if (!data) return null;
  if (data.error) return <p className="text-sm text-amber-400">Couldn’t read sales from Square: {data.error}</p>;

  const open = data.issues.length;
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
              Sales at the swap’s location that PatrolKit can’t put on one of its items · from Square as of {asOf}
            </p>
          </div>
          {canFix && suggested.length > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-400">
                <input type="checkbox" checked={markSold} onChange={(e) => setMarkSold(e.target.checked)} />
                Also mark credited items sold in Square
              </label>
              <button type="button" className={primary} disabled={creditAll.isPending} onClick={confirmCreditAll}>
                {creditAll.isPending ? 'Crediting…' : `Credit all ${suggested.length} suggested`}
              </button>
            </div>
          )}
        </div>
        {groups.length > 0 && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
            {groups.map((g) => <span key={g.kind}>{g.title}: <span className="text-gray-200">{g.issues.length}</span> · {money(g.cents)}</span>)}
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
        {!canFix && open > 0 && <p className="text-xs text-gray-500">An administrator can credit these to the right items.</p>}
      </div>

      {groups.map((g) => (
        <Group key={g.kind} group={g} orgId={orgId} swapId={swapId} canFix={canFix} sellers={sellers} markSold={markSold} onChanged={changed} />
      ))}

      {data.ignoredCategories.length > 0 && (
        <div className="text-xs text-gray-500 space-x-2">
          <span>Never counted:</span>
          {data.ignoredCategories.map((c) => (
            <IgnoredCategory key={c.id} id={c.id} name={c.name} orgId={orgId} swapId={swapId} canFix={canFix} onChanged={changed} />
          ))}
        </div>
      )}

      {data.decided.length > 0 && (
        <details className="bg-surface-50 border border-gray-800 rounded-lg">
          <summary className="cursor-pointer px-4 py-3 text-sm text-gray-300">Decided ({data.decided.length})</summary>
          <ul className="divide-y divide-gray-800">
            {data.decided.map((d) => (
              <Decided key={d.id} d={d} orgId={orgId} swapId={swapId} canFix={canFix}
                onUndone={(r) => { if (r.markedSold && r.itemId) setRestockOffer({ itemId: r.itemId, label: d.item ? `${d.item.sku} ${d.item.name}` : 'that item' }); changed(); }} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Group({ group, orgId, swapId, canFix, sellers, markSold, onChanged }: {
  group: SalesCheckGroup; orgId: string; swapId: string; canFix: boolean; sellers: SellerResponse[]; markSold: boolean; onChanged: () => void;
}) {
  return (
    <section className="border border-gray-800 rounded-lg">
      <div className="p-3 border-b border-gray-800">
        <h4 className="text-white text-sm font-medium">
          {group.title} <span className="text-gray-500">({group.issues.length} · {money(group.cents)})</span>
        </h4>
        <p className="text-xs text-gray-400 mt-0.5">{group.explain}</p>
      </div>
      <ul className="divide-y divide-gray-800">
        {group.issues.map((i) => (
          <Issue key={i.key} issue={i} orgId={orgId} swapId={swapId} canFix={canFix} sellers={sellers} markSold={markSold} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function Issue({ issue, orgId, swapId, canFix, sellers, markSold, onChanged }: {
  issue: SalesCheckIssue; orgId: string; swapId: string; canFix: boolean; sellers: SellerResponse[]; markSold: boolean; onChanged: () => void;
}) {
  const [picking, setPicking] = useState<'item' | 'seller' | null>(null);
  const [seller, setSeller] = useState('');
  const line = { orderId: issue.orderId, lineUid: issue.lineUid };
  const credit = useMutation({ mutationFn: (itemId: string) => api.skiSwap.creditSale(orgId, swapId, { ...line, itemId, markSold }), onSuccess: onChanged });
  const notSwap = useMutation({ mutationFn: (note?: string) => api.skiSwap.notSwapSale(orgId, swapId, { ...line, ...(note ? { note } : {}) }), onSuccess: onChanged });
  const issue_ = useMutation({ mutationFn: () => api.skiSwap.issueAndCreditSale(orgId, swapId, { ...line, sellerId: seller, ticket: issue.ticket! }), onSuccess: onChanged });
  const ignore = useMutation({ mutationFn: (categoryId: string) => api.skiSwap.ignoreSquareCategory(orgId, swapId, { categoryId, ignore: true }), onSuccess: onChanged });
  const busy = credit.isPending || notSwap.isPending || issue_.isPending || ignore.isPending;
  const err = credit.error ?? notSwap.error ?? issue_.error ?? ignore.error;
  const when = new Date(issue.soldAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <li className="p-3 text-sm space-y-2">
      <p className="text-gray-200">{sentence(issue)}</p>
      <p className="text-xs text-gray-500 flex flex-wrap gap-x-3">
        <span>{when}</span>
        {issue.unitPriceCents !== null && issue.kind !== 'oversold' && <span>rung up at {money(issue.unitPriceCents)}</span>}
        {issue.refundedQuantity > 0 && <span>{issue.refundedQuantity} refunded</span>}
        {issue.rungUpAs?.sku && <span>SKU <span className="font-mono">{issue.rungUpAs.sku}</span></span>}
        {issue.suggestion && <span>ours: {issue.suggestion.name} · {issue.suggestion.priceCents === null ? 'unpriced' : money(issue.suggestion.priceCents)}</span>}
        {issue.oversold && <span>orders {issue.oversold.orders.join(', ')}</span>}
        {issue.links.sale && <a href={issue.links.sale} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">Sale in Square ↗</a>}
        {issue.links.item && <a href={issue.links.item} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">Item in Square ↗</a>}
      </p>
      {err && <p className="text-xs text-red-400">{errorText(err)}</p>}

      {canFix && issue.kind !== 'oversold' && (
        <div className="flex flex-wrap items-center gap-2">
          {issue.suggestion && (
            <button type="button" className={primary} disabled={busy} onClick={() => credit.mutate(issue.suggestion!.itemId)}>
              Credit to {issue.suggestion.sku}
            </button>
          )}
          {issue.kind === 'unknown_ticket' && (
            <button type="button" className={btn} disabled={busy} onClick={() => setPicking(picking === 'seller' ? null : 'seller')}>Issue to a seller…</button>
          )}
          <button type="button" className={btn} disabled={busy} onClick={() => setPicking(picking === 'item' ? null : 'item')}>
            Credit to {issue.suggestion ? 'another' : 'an'} item…
          </button>
          <button type="button" className={btn} disabled={busy}
            onClick={() => { const note = window.prompt('Not a swap sale. A note, if you like (e.g. “swag”):', ''); if (note !== null) notSwap.mutate(note.trim() || undefined); }}>
            Not a swap sale
          </button>
          {issue.kind === 'other_item' && issue.categoryIds.length > 0 && issue.rungUpAs?.category && (
            <button type="button" className={btn} disabled={busy}
              onClick={() => { if (window.confirm(`Never count sales from “${issue.rungUpAs!.category}” as swap sales? They stop showing here. You can count them again below.`)) ignore.mutate(issue.categoryIds[0]); }}>
              Never count “{issue.rungUpAs.category}”
            </button>
          )}
          {busy && <span className="text-xs text-gray-400">Working…</span>}
        </div>
      )}

      {picking === 'item' && <ItemPicker orgId={orgId} swapId={swapId} onPick={(id) => { setPicking(null); credit.mutate(id); }} />}
      {picking === 'seller' && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-64">
            <SearchableSelect value={seller} onChange={setSeller} placeholder="Whose ticket is it?" clearLabel="No seller chosen"
              options={sellers.map((s) => ({ value: s.id, label: s.displayName, sublabel: s.phone ?? undefined, keywords: s.email ?? undefined }))} />
          </div>
          <button type="button" className={primary} disabled={!seller || busy}
            onClick={() => { if (window.confirm(`Issue ticket ${issue.ticket} to this seller, put it in Square, and credit this sale to it?`)) issue_.mutate(); }}>
            Issue {issue.ticket} and credit
          </button>
        </div>
      )}
    </li>
  );
}

/** "Credit to another item…": the Items search, by ticket or name. */
function ItemPicker({ orgId, swapId, onPick }: { orgId: string; swapId: string; onPick: (itemId: string) => void }) {
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
        <button key={it.id} type="button" onClick={() => onPick(it.id)}
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
        {d.decision === 'CREDIT' ? `Credited ${money(d.collectedCents)} to ${d.item ? `${d.item.sku} ${d.item.name}` : 'an item'}` : `Not a swap sale (${money(d.collectedCents)})`}
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
