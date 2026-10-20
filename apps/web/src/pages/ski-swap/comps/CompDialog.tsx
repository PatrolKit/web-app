import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../../lib/api';
import { usd } from '../../../lib/money';
import type { CompReason, ItemResponse } from '../../../lib/api.types';
import { COMP_REASONS, sellerGets } from './compView';

/**
 * Comp an item (Plan 53 D9): marks it sold with no Square sale behind it, so
 * its seller is paid the list price. Always the list price (D4): an unpriced
 * item is priced here first, and that becomes its list price.
 */
export default function CompDialog({ orgId, swapId, item: given, onClose, onDone }: {
  /** The item, from its row on Items; without one, the dialog starts with a search for it. */
  orgId: string; swapId: string; item?: ItemResponse; onClose: () => void; onDone: (message: string) => void;
}) {
  const [picked, setPicked] = useState<ItemResponse | null>(given ?? null);
  const [reason, setReason] = useState<CompReason | null>(null);
  const [note, setNote] = useState('');
  const [price, setPrice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: settings } = useQuery({
    queryKey: ['ski-swap/settings', orgId],
    queryFn: () => api.skiSwap.getSettings(orgId),
    staleTime: 60_000,
  });

  const item = picked;
  const unpriced = item?.priceCents === null;
  const typed = Math.round(Number(price.replace(/[$,\s]/g, '')) * 100);
  const priceCents = !item ? null : unpriced ? (Number.isFinite(typed) && typed > 0 ? typed : null) : item.priceCents;
  const units = 1;
  const seller = item?.seller?.displayName ?? 'Its seller';
  const gets = priceCents !== null && settings ? sellerGets(priceCents, units, settings.commissionBasisPoints) : null;
  const ready = !!reason && note.trim().length > 0 && priceCents !== null;

  const save = async () => {
    if (!item || !ready || priceCents === null) return;
    const ask = `Comp ${item.sku} for ${usd(priceCents)}?${gets !== null ? ` ${seller} will be paid ${usd(gets)} for it.` : ''} Square’s stock goes to 0.`;
    if (!confirm(ask)) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.skiSwap.compItem(orgId, swapId, item.id, { reason: reason!, note: note.trim(), ...(unpriced ? { priceCents } : {}) });
      onDone(res.stockError
        ? `Comped ${item.sku}, but Square’s stock couldn’t be set (${res.stockError}). Set it to 0 in Square.`
        : `Comped ${item.sku}. ${seller} will be paid for it.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t comp it. Try again.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="comp-title" className="w-full max-w-lg bg-surface-50 border border-gray-700 rounded-lg mt-16"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 id="comp-title" className="text-white font-semibold">{item ? `Comp ${item.sku}` : 'Comp an item'}</h3>
          <p className="text-xs text-gray-400 mt-1">
            {item ? `${item.name} · ${seller}. ` : 'Find the item by its ticket number or name. '}
            Marks it sold with no sale in Square, so its seller is paid the list price. Customers see it as sold.
          </p>
        </div>
        {!item ? (
          <>
            <div className="p-5"><ItemSearch orgId={orgId} swapId={swapId} onPick={setPicked} /></div>
            <div className="px-5 py-3 border-t border-gray-800 flex justify-end">
              <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Cancel</button>
            </div>
          </>
        ) : (<>
        <div className="p-5 space-y-4 text-sm">
          <div>
            <p className="text-gray-300 mb-1">List price</p>
            {unpriced ? (
              <div className="space-y-1">
                <div className="relative w-32">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-500">$</span>
                  <input autoFocus inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00"
                    className="w-full bg-surface-100 border border-gray-700 rounded pl-5 pr-2 py-1.5 text-white" />
                </div>
                <p className="text-xs text-amber-300">{item.sku} has no price. This becomes its list price, in PatrolKit and Square.</p>
              </div>
            ) : (
              <p className="text-white">{usd(item.priceCents!)}</p>
            )}
            {gets !== null && <p className="text-xs text-gray-400 mt-1">{seller} is paid {usd(gets)} after the patrol’s share.</p>}
          </div>
          <fieldset className="space-y-1.5">
            <legend className="text-gray-300 mb-1">Why</legend>
            {COMP_REASONS.map((r) => (
              <label key={r.value} className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="comp-reason" className="mt-1" checked={reason === r.value} onChange={() => setReason(r.value)} />
                <span><span className="text-white">{r.label}</span> <span className="text-gray-500 text-xs">{r.hint}</span></span>
              </label>
            ))}
          </fieldset>
          <label className="block">
            <span className="text-gray-300">Note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What happened, for the record."
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white" />
          </label>
          {error && <p className="text-red-300">{error}</p>}
        </div>
        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          {!given && (
            <button type="button" onClick={() => { setPicked(null); setPrice(''); setError(null); }}
              className="mr-auto text-sm text-gray-400 hover:text-white">← Another item</button>
          )}
          <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Cancel</button>
          <button type="button" disabled={!ready || saving} onClick={save}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-1.5 rounded text-sm font-medium">
            {saving ? 'Comping…' : 'Comp it'}
          </button>
        </div>
        </>)}
      </div>
    </div>
  );
}

/** The Items search, by ticket or name: only items that could be comped can be picked, and the rest say why not. */
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
    <div className="space-y-2 text-sm">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ticket number or name…"
        className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-white" />
      {isFetching && <p className="text-xs text-gray-500">Searching…</p>}
      {q.trim().length >= 2 && !isFetching && data?.items.length === 0 && <p className="text-xs text-gray-500">Nothing matches.</p>}
      <ul className="max-h-72 overflow-y-auto divide-y divide-gray-800">
        {data?.items.map((it) => {
          const no = why(it);
          return (
            <li key={it.id}>
              <button type="button" disabled={!!no} onClick={() => onPick(it)}
                className="w-full text-left py-2 px-1 rounded hover:bg-surface-100 disabled:hover:bg-transparent text-gray-300 disabled:text-gray-600 disabled:cursor-not-allowed">
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
