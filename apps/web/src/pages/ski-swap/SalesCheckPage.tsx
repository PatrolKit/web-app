import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import SearchableSelect from '../../components/SearchableSelect';
import type { SalesCheckDecided, SalesCheckIssue, SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import {
  byCategory, groupsOf, money, patrolKitSide, squareSide, suggestedLines, type CategoryGroup, type SalesCheckGroup, type Side,
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

  const groups = useMemo(() => groupsOf(data?.issues ?? []), [data]);
  const suggested = useMemo(() => suggestedLines(data?.issues ?? []), [data]);
  const creditAll = useMutation({
    mutationFn: () => api.skiSwap.creditSuggestedSales(orgId, swapId, { lines: suggested.map(({ orderId, lineUid, itemId }) => ({ orderId, lineUid, itemId })), markSold }),
    onSuccess: (r) => {
      const ok = r.outcomes.filter((o) => o.ok).length;
      const failed = r.outcomes.filter((o) => !o.ok);
      setResult(`${ok} accepted${failed.length ? `; ${failed.length} not: ${[...new Set(failed.map((f) => f.error))].join(' ')}` : ''}`);
      changed();
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
        {!canFix && open > 0 && <p className="text-xs text-gray-500">An administrator can resolve these.</p>}
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
  const card = (i: SalesCheckIssue) => <Issue key={i.key} issue={i} orgId={orgId} swapId={swapId} canFix={canFix} sellers={sellers} markSold={markSold} onChanged={onChanged} />;
  return (
    <section className="border border-gray-800 rounded-lg">
      <div className="p-3 border-b border-gray-800">
        <h4 className="text-white text-sm font-medium">
          {group.title} <span className="text-gray-500">({group.issues.length} · {money(group.cents)})</span>
        </h4>
        <p className="text-xs text-gray-400 mt-0.5">{group.explain}</p>
      </div>
      {group.kind === 'other_item' ? (
        <ul className="divide-y divide-gray-800">
          {byCategory(group.issues).map((c) => (
            <Category key={c.name} category={c} orgId={orgId} swapId={swapId} canFix={canFix} onChanged={onChanged}>{c.issues.map(card)}</Category>
          ))}
        </ul>
      ) : (
        <div className="p-3 space-y-3">{group.issues.map(card)}</div>
      )}
    </section>
  );
}

/** Other items: one row per Square category, its sales folded away until opened. */
function Category({ category: c, orgId, swapId, canFix, onChanged, children }: {
  category: CategoryGroup; orgId: string; swapId: string; canFix: boolean; onChanged: () => void; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ignore = useMutation({ mutationFn: (categoryId: string) => api.skiSwap.ignoreSquareCategory(orgId, swapId, { categoryId, ignore: true }), onSuccess: onChanged });
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

function SidePanel({ side, icon, className = '' }: { side: Side; icon: string; className?: string }) {
  return (
    <div className={`p-3 min-w-0 ${className}`}>
      <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">{icon} {side.title}</p>
      {side.empty ? <p className="text-xs text-gray-400">{side.empty}</p> : (
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 text-sm">
          {side.fields.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-xs text-gray-500 pt-0.5">{f.label}</dt>
              <dd className={`min-w-0 break-words ${f.mono ? 'font-mono' : ''} ${f.warn ? 'text-amber-400' : 'text-gray-200'}`}>
                {f.value}
                {f.tag && <span className="ml-1.5 inline-block whitespace-nowrap text-[11px] bg-amber-900/40 text-amber-300 rounded px-1.5 py-px font-sans">{f.tag}</span>}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {side.links.length > 0 && (
        <p className="mt-2 flex gap-3 text-xs">
          {side.links.map((l) => 'href' in l
            ? <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">{l.label} ↗</a>
            : <Link key={l.label} to={l.to} className="text-brand-500 hover:underline">{l.label} ›</Link>)}
        </p>
      )}
    </div>
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
  const busy = credit.isPending || notSwap.isPending || issue_.isPending;
  const err = credit.error ?? notSwap.error ?? issue_.error;
  const when = new Date(issue.soldAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden bg-surface-50">
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1.75rem_minmax(0,1fr)]">
        <SidePanel side={squareSide(issue)} icon="■" />
        <div className="hidden md:flex items-center justify-center text-gray-600">→</div>
        <SidePanel side={patrolKitSide(issue)} icon="◆" className="border-t md:border-t-0 md:border-l border-gray-800" />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-gray-800 bg-surface-100/40">
        <span className="text-xs text-gray-500 mr-auto">{when}</span>
        {err && <span className="text-xs text-red-400">{errorText(err)}</span>}
        {busy && <span className="text-xs text-gray-400">Working…</span>}
        {canFix && issue.kind !== 'oversold' && (
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
            {issue.suggestion && (
              <button type="button" className={primary} disabled={busy} onClick={() => credit.mutate(issue.suggestion!.itemId)}>
                Accept suggestion
              </button>
            )}
          </>
        )}
      </div>

      {picking === 'item' && <div className="px-3 pb-3"><ItemPicker orgId={orgId} swapId={swapId} onPick={(id) => { setPicking(null); credit.mutate(id); }} /></div>}
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
        {d.decision === 'CREDIT' ? `${money(d.collectedCents)} sale put on ${d.item ? `${d.item.sku} ${d.item.name}` : 'an item'}` : `Not a swap sale (${money(d.collectedCents)})`}
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
