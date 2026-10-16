import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../../lib/api';
import { usd } from '../../../lib/money';
import type { PayoutRun } from '../../../lib/api.types';
import { methodLabel } from './payoutView';

/**
 * "Add sellers" (Plan 52 D3): only the sellers this run can pay, meaning its
 * own payout method, complete details, something owed, and no other run.
 * Search, checkboxes, "select all shown".
 */
export default function AddSellersDialog({ orgId, run, onClose, onAdded }: {
  orgId: string; run: PayoutRun; onClose: () => void; onAdded: (count: number) => void;
}) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: eligible, isLoading } = useQuery({
    queryKey: ['ski-swap/payout-choices', orgId, run.id],
    queryFn: () => api.skiSwap.payoutChoices(orgId, run.id),
  });

  const shown = useMemo(() => {
    const all = eligible ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((s) => s.name.toLowerCase().includes(needle) || (s.destination ?? '').toLowerCase().includes(needle)) : all;
  }, [eligible, q]);
  const allShown = shown.length > 0 && shown.every((s) => picked.has(s.sellerId));
  const flip = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const add = async () => {
    setSaving(true);
    setError(null);
    try {
      const { results } = await api.skiSwap.addPayoutSellers(orgId, run.id, [...picked]);
      const added = results.filter((r) => r.result === 'added').length;
      const missed = results.length - added;
      if (missed) {
        setError(`${missed} couldn’t be added: they changed since this list was read. Close and open it again.`);
        setSaving(false);
        if (added) onAdded(added);
        return;
      }
      onAdded(added);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Couldn’t add them. Try again.');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="add-sellers-title" className="w-full max-w-2xl bg-surface-50 border border-gray-700 rounded-lg mt-12"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-800">
          <h3 id="add-sellers-title" className="text-white font-semibold">Add sellers</h3>
          <p className="text-xs text-gray-400 mt-1">
            {run.kind === 'PAYPAL' ? 'Sellers paid by PayPal or Venmo' : 'Sellers paid by check'} who are owed something, have complete payout
            details, and aren’t in a run yet. Sellers with issues can be added; they can’t be approved until they’re resolved.
          </p>
        </div>
        <div className="px-5 py-3 flex items-center gap-3 border-b border-gray-800">
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or destination"
            className="flex-1 bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-sm text-white" />
          <label className="text-xs text-gray-300 flex items-center gap-1.5 whitespace-nowrap">
            <input type="checkbox" checked={allShown} disabled={!shown.length}
              onChange={() => setPicked((p) => { const n = new Set(p); for (const s of shown) { if (allShown) n.delete(s.sellerId); else n.add(s.sellerId); } return n; })} />
            Select all shown
          </label>
        </div>
        <ul className="max-h-96 overflow-y-auto divide-y divide-gray-800">
          {isLoading && <li className="px-5 py-6 text-sm text-gray-500 text-center">Reading sales…</li>}
          {shown.map((s) => (
            <li key={s.sellerId}>
              <label className="flex items-center gap-3 px-5 py-2.5 hover:bg-surface-100 cursor-pointer">
                <input type="checkbox" checked={picked.has(s.sellerId)} onChange={() => flip(s.sellerId)} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white truncate">{s.name}{s.business && <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">business</span>}</p>
                  <p className="text-xs text-gray-500 truncate">{run.kind === 'CHECK' ? s.destination : `${methodLabel(s.method)} · ${s.destination}`}</p>
                  {s.notPaidBefore && <p className="text-xs text-amber-300">PayPal didn’t pay them in an earlier run. Check their details are right.</p>}
                </div>
                {s.flags.length > 0 && <span className="text-xs px-2 py-0.5 rounded border border-amber-700/60 text-amber-300" title={s.flags.map((f) => f.text).join('\n')}>⚑ {s.flags.length} {s.flags.length === 1 ? 'issue' : 'issues'}</span>}
                <span className="text-xs text-gray-400 w-14 text-right">{s.items} {s.items === 1 ? 'item' : 'items'}</span>
                <span className="text-sm text-white w-20 text-right">{usd(s.netCents)}</span>
              </label>
            </li>
          ))}
          {!isLoading && shown.length === 0 && (
            <li className="px-5 py-6 text-sm text-gray-500 text-center">{eligible?.length ? 'Nobody matches.' : 'Nobody left to add to a run of this kind.'}</li>
          )}
        </ul>
        {error && <p className="px-5 pt-3 text-sm text-red-300">{error}</p>}
        <div className="px-5 py-3 border-t border-gray-800 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="text-sm px-3 py-1.5 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Cancel</button>
          <button type="button" disabled={!picked.size || saving} onClick={add}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium">
            {saving ? 'Adding…' : `Add ${picked.size || ''} ${picked.size === 1 ? 'seller' : 'sellers'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
