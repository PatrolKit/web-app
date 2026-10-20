import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { usd } from '../../lib/money';
import type { CompView, ItemResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import CompDialog from './comps/CompDialog';
import { compReasonLabel } from './comps/compView';

/**
 * Adjustments → Comps (Plan 53 D10): every comp of the swap, with the total
 * the patrol owes sellers that Square never took. Comping and undoing are for
 * Ski Swap admins only (D9).
 */
export default function CompsPage() {
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const isAdmin = perms.has('ski_swap:admin');
  const [picking, setPicking] = useState(false);
  const [comping, setComping] = useState<ItemResponse | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [showUndone, setShowUndone] = useState(false);

  const key = ['ski-swap/comps', orgId, selectedSwap?.id];
  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.skiSwap.listComps(orgId, selectedSwap!.id),
    enabled: !!orgId && !!selectedSwap,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['ski-swap/items'] });
    qc.invalidateQueries({ queryKey: ['ski-swap/payouts-summary'] });
  };

  if (!selectedSwap) return <p className="text-gray-400">Pick a swap to see its comps.</p>;

  const undo = async (c: CompView) => {
    const note = prompt(`Undo the comp on ${c.item.sku}? It counts as unsold again, and Square’s stock goes back. Why?`);
    if (!note?.trim()) return;
    try {
      const res = await api.skiSwap.undoComp(orgId, selectedSwap.id, c.id, note.trim());
      setResult(res.stockError
        ? { ok: false, message: `Undone, but Square’s stock couldn’t be set (${res.stockError}). Set ${c.item.sku}’s stock in Square.` }
        : { ok: true, message: `Undone. ${c.item.sku} counts as unsold again.` });
    } catch (err) {
      setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Couldn’t undo it.' });
    }
    refresh();
  };

  const live = data?.comps.filter((c) => !c.undone) ?? [];
  const undone = data?.comps.filter((c) => c.undone) ?? [];

  return (
    <div className="space-y-5 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-white font-medium">Comps</h2>
          <p className="text-xs text-gray-500">
            An item that sold with no sale in Square: paid for outside the register, sold with no sale to be found, or lost
            or damaged. Comping it marks it sold, so its seller is paid the list price. Customers see it as sold.
          </p>
        </div>
        {isAdmin && (
          <button type="button" onClick={() => setPicking(!picking)}
            className="shrink-0 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
            + Comp Item
          </button>
        )}
      </div>

      {picking && (
        <ItemSearch orgId={orgId} swapId={selectedSwap.id} onPick={(it) => { setPicking(false); setComping(it); }} />
      )}
      {result && <p className={`text-sm ${result.ok ? 'text-green-400' : 'text-red-300'}`}>{result.message}</p>}
      {isLoading && <p className="text-gray-400">Loading…</p>}
      {error && <p className="text-red-300 text-sm">{error instanceof ApiError ? error.message : 'Couldn’t load comps.'}</p>}

      {data && (
        <>
          <p className="text-sm text-gray-300">
            {data.live.count === 0
              ? 'Nothing comped.'
              : <>{data.live.count} comped {data.live.count === 1 ? 'item' : 'items'}, <strong className="text-white">{usd(data.live.totalCents)}</strong> at list price: owed to sellers, with no sale in Square.</>}
          </p>
          {live.length > 0 && <CompTable comps={live} isAdmin={isAdmin} onUndo={undo} />}
          {undone.length > 0 && (
            <div className="space-y-2">
              <button type="button" onClick={() => setShowUndone(!showUndone)} className="text-xs text-gray-400 hover:text-white underline">
                {showUndone ? 'Hide' : 'Show'} {undone.length} undone
              </button>
              {showUndone && <CompTable comps={undone} isAdmin={false} onUndo={undo} />}
            </div>
          )}
        </>
      )}

      {comping && (
        <CompDialog orgId={orgId} swapId={selectedSwap.id} item={comping} onClose={() => setComping(null)}
          onDone={(message) => { setComping(null); setResult({ ok: true, message }); refresh(); }} />
      )}
    </div>
  );
}

function CompTable({ comps, isAdmin, onUndo }: { comps: CompView[]; isAdmin: boolean; onUndo: (c: CompView) => void }) {
  const when = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <div className="border border-gray-700 rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
            <th className="px-3 py-2 font-normal">Ticket</th>
            <th className="px-3 py-2 font-normal">Seller</th>
            <th className="px-3 py-2 font-normal text-right">List price</th>
            <th className="px-3 py-2 font-normal">Why</th>
            <th className="px-3 py-2 font-normal">Comped</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {comps.map((c) => (
            <tr key={c.id} className={`border-b border-gray-800/60 align-top ${c.undone ? 'opacity-60' : ''}`}>
              <td className="px-3 py-2">
                <span className="font-mono text-brand-400">{c.item.sku}</span>
                <span className="block text-xs text-gray-400">{c.item.name}{c.item.deleted && ' (deleted)'}{c.units > 1 && ` × ${c.units}`}</span>
              </td>
              <td className="px-3 py-2 text-gray-300">
                {c.seller ? <Link to={`/dashboard/ski-swap/sellers?edit=${c.seller.id}`} className="hover:text-white hover:underline">{c.seller.name}</Link> : '—'}
              </td>
              <td className="px-3 py-2 text-right text-white whitespace-nowrap">{usd(c.priceCents * c.units)}</td>
              <td className="px-3 py-2">
                <span className="text-gray-200">{compReasonLabel(c.reason)}</span>
                <span className="block text-xs text-gray-400 whitespace-pre-wrap">{c.note}</span>
                {c.undone && <span className="block text-xs text-gray-500">Undone {when(c.undone.at)}{c.undone.byName && ` by ${c.undone.byName}`}{c.undone.note && `: ${c.undone.note}`}</span>}
              </td>
              <td className="px-3 py-2 text-xs text-gray-400 whitespace-nowrap">{when(c.compedAt)}{c.compedByName && <span className="block">{c.compedByName}</span>}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {isAdmin && !c.undone && (c.paid
                  ? <span className="text-xs text-gray-500" title="The seller was paid for it. Settle a change by hand on their payout card.">Paid</span>
                  : <button type="button" onClick={() => onUndo(c)} className="text-xs px-2.5 py-1 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Undo comp…</button>)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Comp an item…": the Items search, by ticket or name; only items that could be comped are offered. */
function ItemSearch({ orgId, swapId, onPick }: { orgId: string; swapId: string; onPick: (item: ItemResponse) => void }) {
  const [q, setQ] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['ski-swap/comp-search', orgId, swapId, q],
    queryFn: () => api.skiSwap.listItems(orgId, swapId, { query: q, take: 10 }),
    enabled: q.trim().length >= 2,
  });
  const why = (it: ItemResponse): string | null =>
    it.comp ? 'already comped'
      : it.pickedUpAt ? 'picked up'
        : !it.consignedAt ? 'not received'
          : !it.squareSynced ? 'not in Square'
            : it.inventoryKnown && it.inStock < 1 ? 'already sold'
              : null;
  return (
    <div className="border border-gray-700 bg-surface-50 rounded-lg p-3 space-y-2">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticket number or name…"
        className="w-72 bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-sm text-white" />
      {isFetching && <p className="text-xs text-gray-500">Searching…</p>}
      <ul className="space-y-1">
        {data?.items.map((it) => {
          const no = why(it);
          return (
            <li key={it.id}>
              <button type="button" disabled={!!no} onClick={() => onPick(it)}
                className="text-left text-sm text-gray-300 hover:text-white disabled:text-gray-600 disabled:cursor-not-allowed">
                <span className="font-mono text-brand-400">{it.sku}</span> {it.name} · {it.priceCents === null ? 'unpriced' : usd(it.priceCents)}
                {it.seller ? ` · ${it.seller.displayName}` : ''}{no && ` · ${no}`}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
