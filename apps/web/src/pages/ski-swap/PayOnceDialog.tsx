import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { SalesCheckIssue } from '../../lib/api.types';
import { money, payOnceChoices } from './salesCheckView';

/**
 * Pay once: a ticket rung up more than once in one sale. Its seller is paid
 * for exactly one, at the list price, and the rest isn't paid to anyone. A
 * sale with several lines asks which line was the ticket (the one at the list
 * price to start with); one line rung up as a quantity of 2 asks nothing.
 */
export default function PayOnceDialog({ orgId, swapId, issue, initialNote, onClose, onDone }: {
  orgId: string; swapId: string; issue: SalesCheckIssue; initialNote: string;
  onClose: () => void; onDone: (text: string) => void;
}) {
  const o = issue.oversold!;
  const { choices, picked: start } = payOnceChoices(o);
  const [picked, setPicked] = useState<string | null>(start);
  const [note, setNote] = useState(initialNote);
  const [refused, setRefused] = useState<string | null>(null);
  const chosen = choices.find((c) => c.lineUid === picked) ?? null;
  // The list price; an unpriced ticket is paid what its line was rung up at.
  const pays = o.priceCents ?? chosen?.unitCents ?? null;
  const seller = o.sellerName ?? 'The seller';
  const one = o.quantity === 1 ? 'one' : String(o.quantity);
  const extra = o.units - o.quantity;

  const save = useMutation({
    mutationFn: () => api.skiSwap.payOnce(orgId, swapId, { orderId: issue.orderId, itemId: o.itemId, lineUid: picked!, note: note.trim().slice(0, 500) }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => {
      if (!r.ok) { setRefused(r.error ?? 'That didn’t work. Try again.'); return; }
      onDone(`Paid once: ${seller} is paid for ${one} ${o.sku}${pays !== null ? `, at ${money(pays)}` : ''}.`);
    },
    onError: (err) => setRefused(err instanceof ApiError ? err.message : 'That didn’t work. Try again.'),
  });
  const ready = !!picked && note.trim().length > 0 && !save.isPending;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="pay-once-title" className="w-full max-w-lg bg-surface-50 border border-gray-700 rounded-lg mt-16"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 id="pay-once-title" className="text-white font-semibold">Pay {o.sku} once</h3>
          <p className="text-xs text-gray-400 mt-1">{o.name} · {seller}</p>
        </div>
        <div className="p-5 space-y-4 text-sm">
          {choices.length > 1 && (
            <fieldset className="space-y-1.5">
              <legend className="text-gray-300 mb-1">Which line was {o.sku}?</legend>
              {choices.map((c) => (
                <label key={c.lineUid} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="pay-once-line" checked={picked === c.lineUid} onChange={() => setPicked(c.lineUid)} />
                  <span className="text-white">{c.label}</span>
                  {c.matches && <span className="text-xs text-green-400">list price</span>}
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-white">
            {pays !== null && picked
              ? <>{seller} is paid for <strong>{one}</strong>, at <strong>{money(pays)}</strong>{o.priceCents === null ? ', what that line was rung up at' : ', the list price'}.</>
              : <>{seller} is paid for {one}, for the line you pick.</>}
            {' '}
            <span className="text-gray-400">
              {choices.length > 1
                ? 'The other lines aren’t paid to anyone.'
                : `The other ${extra === 1 ? 'charge isn’t' : `${extra} charges aren’t`} paid to anyone.`}
            </span>
          </p>
          <label className="block">
            <span className="text-gray-300">Note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
              placeholder="How the rest was settled, e.g. customer refunded $20 by check."
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white" />
          </label>
          {refused && <p className="text-red-300">{refused}</p>}
        </div>
        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Cancel</button>
          <button type="button" disabled={!ready} onClick={() => save.mutate()}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-1.5 rounded text-sm font-medium">
            {save.isPending ? 'Saving…' : `Pay for ${one}${pays !== null && picked ? ` at ${money(pays)}` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
