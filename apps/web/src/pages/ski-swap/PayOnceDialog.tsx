import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { SalesCheckIssue } from '../../lib/api.types';
import { money, payOnceChoices } from './salesCheckView';

/**
 * Pay once: a ticket rung up more than once in one sale, settled outside
 * Square. Staff pick the line its seller is paid for (the one at PatrolKit's
 * price to start with); the rest stay unpaid, and the sale stays as Square
 * has it.
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
  // What the seller is paid on: PatrolKit's price, or for an unpriced ticket what the line was rung up at.
  const paysCents = o.priceCents ?? chosen?.unitCents ?? null;
  const seller = o.sellerName ?? 'The seller';

  const save = useMutation({
    mutationFn: () => api.skiSwap.payOnce(orgId, swapId, { orderId: issue.orderId, itemId: o.itemId, lineUid: picked!, note: note.trim().slice(0, 500) }),
    onMutate: () => setRefused(null),
    onSuccess: (r) => {
      if (!r.ok) { setRefused(r.error ?? 'That didn’t work. Try again.'); return; }
      onDone(`Paid once: ${o.sku} pays ${seller} on ${chosen ? chosen.label.replace(/^Line/, 'line') : 'the line picked'}; the rest is settled outside Square.`);
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
          <p className="text-xs text-gray-400 mt-1">
            {o.name} · {seller} · {o.priceCents === null ? 'unpriced' : money(o.priceCents)}. Pick the line {seller} is paid
            for. The other lines stay unpaid, and the sale stays as Square has it.
          </p>
        </div>
        <div className="p-5 space-y-4 text-sm">
          <fieldset className="space-y-1.5">
            <legend className="text-gray-300 mb-1">Paid for</legend>
            {choices.map((c) => (
              <label key={c.lineUid} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="pay-once-line" checked={picked === c.lineUid} onChange={() => setPicked(c.lineUid)} />
                <span className="text-white">{c.label}</span>
                {c.matches && <span className="text-xs text-green-400">PatrolKit’s price</span>}
              </label>
            ))}
          </fieldset>
          {paysCents !== null && picked && (
            <p className="text-gray-300">
              {seller} is owed on {money(paysCents)}
              {o.priceCents === null ? ', what that line was rung up at' : ''}, once.
            </p>
          )}
          <label className="block">
            <span className="text-gray-300">How was the rest settled?</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3}
              placeholder="e.g. Customer refunded $20 by check; the $10 was ticket 75042."
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white" />
          </label>
          {refused && <p className="text-red-300">{refused}</p>}
        </div>
        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Cancel</button>
          <button type="button" disabled={!ready} onClick={() => save.mutate()}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-1.5 rounded text-sm font-medium">
            {save.isPending ? 'Saving…' : 'Pay once'}
          </button>
        </div>
      </div>
    </div>
  );
}
