import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import type {
  SellerMergeChoices,
  SellerMergeLine,
  SellerMergePreviewResponse,
  SellerMergeSide,
} from '@patrolkit/contracts/seller-merge.contracts';

const LINE_EFFECT: Record<SellerMergeLine['effect'], string> = {
  removed: 'taken out of the run',
  unapproved: 'back to needing review',
  stays: 'unchanged',
  history: 'kept as history; it paid nothing',
  blocks: 'already paid: stops the merge',
};

/**
 * Merging two seller records that are one seller (Plan 57).
 *
 * Opened from a seller's Edit dialog: choose the other record, which one stays,
 * and what the kept one takes from the other. Nothing changes until the last
 * button, and the server checks again that nothing changed since this preview.
 */
export default function MergeSellersModal({
  orgId,
  start,
  onClose,
  onMerged,
}: {
  orgId: string;
  /** The seller whose Edit dialog this was opened from. */
  start: SellerResponse;
  onClose: () => void;
  /** The kept seller's id, once merged. */
  onMerged: (keptSellerId: string) => void;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [otherId, setOtherId] = useState<string | null>(null);
  /** Which of the two stays. Unset until the first preview suggests one. */
  const [keepId, setKeepId] = useState<string | null>(null);
  const [choices, setChoices] = useState<SellerMergeChoices>({ address: 'keep', payout: 'keep', businessName: 'keep' });

  // Every seller, whatever the page behind is filtered to. Shares the page's cache.
  const { data: sellers = [] } = useQuery({
    queryKey: ['ski-swap/sellers', orgId, false],
    queryFn: () => api.skiSwap.listSellers(orgId, undefined, false),
    staleTime: 30_000,
  });

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return sellers
      .filter((s) => s.id !== start.id && !s.deletedAt)
      .filter((s) => [s.displayName, s.businessName, s.email, s.phone].some((v) => v?.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [query, sellers, start.id]);

  const pair = otherId ? (keepId === otherId ? { keep: otherId, other: start.id } : { keep: start.id, other: otherId }) : null;
  const { data: preview, isFetching, error } = useQuery({
    queryKey: ['ski-swap/seller-merge', orgId, pair?.keep, pair?.other],
    queryFn: () => api.skiSwap.mergeSellersPreview(orgId, pair!.keep, pair!.other),
    enabled: !!pair,
  });

  // The first preview says which looks like the one to keep; after that it's the admin's call.
  useEffect(() => {
    if (preview && keepId === null) setKeepId(preview.suggestedKeepId);
  }, [preview, keepId]);

  // Sensible starting choices for whichever pair is shown: an address or payout the kept seller lacks.
  useEffect(() => {
    if (!preview) return;
    setChoices({
      address: !preview.choices.address.keep && preview.choices.address.offered ? 'other' : 'keep',
      payout: !preview.choices.payout.keep && preview.choices.payout.offered ? 'other' : 'keep',
      businessName: 'keep',
    });
  }, [preview]);

  const merge = useMutation({
    mutationFn: (p: SellerMergePreviewResponse) =>
      api.skiSwap.mergeSellers(orgId, p.keep.sellerId, { otherSellerId: p.other.sellerId, choices, expected: p.expected }),
    onSuccess: async (result) => {
      // Waited for, so the kept seller opens with what they hold now, not the list from before.
      await qc.invalidateQueries({ queryKey: ['ski-swap/sellers', orgId] });
      onMerged(result.keptSellerId);
    },
  });

  function confirmMerge(p: SellerMergePreviewResponse) {
    const name = namesOf(p);
    if (!window.confirm(`Merge ${name.other} into ${name.keep}? ${name.other} is retired and can't be brought back from here.`)) return;
    merge.mutate(p);
  }

  const otherSeller = sellers.find((s) => s.id === otherId);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Merge sellers" className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div>
            <h3 className="text-white font-medium">Merge sellers</h3>
            <p className="text-xs text-gray-500">For two records that are one seller. Everything moves to the one you keep.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-white text-lg leading-none">✕</button>
        </div>

        <div className="px-5 py-4 space-y-5 overflow-y-auto">
          {/* 1. The other record */}
          <section className="space-y-2">
            <h4 className="text-sm text-gray-300">Merge <span className="text-white font-medium">{start.displayName}</span> with</h4>
            {otherSeller ? (
              <div className="flex items-center gap-3">
                <span className="text-white">{otherSeller.displayName}</span>
                <button type="button" className="text-xs text-brand-500 hover:underline" onClick={() => { setOtherId(null); setKeepId(null); merge.reset(); }}>
                  Choose someone else
                </button>
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name, business, email or phone"
                  className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
                />
                {candidates.length > 0 && (
                  <ul className="border border-gray-800 rounded divide-y divide-gray-800">
                    {candidates.map((s) => (
                      <li key={s.id}>
                        <button type="button" onClick={() => setOtherId(s.id)} className="w-full text-left px-3 py-2 hover:bg-surface-100">
                          <span className="text-white text-sm">{s.displayName}</span>
                          <span className="text-xs text-gray-500 ml-2">{[s.businessName ? 'Business' : null, s.email, s.phone].filter(Boolean).join(' · ')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {query.trim() && candidates.length === 0 && <p className="text-xs text-gray-500">No other seller matches.</p>}
              </>
            )}
          </section>

          {error && <p className="text-sm text-red-400">{(error as Error).message}</p>}
          {otherId && !preview && isFetching && <p className="text-sm text-gray-400">Looking at both…</p>}

          {preview && (
            <>
              {/* 2. Which one stays */}
              <section className="space-y-2">
                <h4 className="text-sm text-gray-300">Which one stays?</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[preview.keep, preview.other].map((side) => (
                    <SideCard
                      key={side.sellerId}
                      side={side}
                      kept={side.sellerId === preview.keep.sellerId}
                      suggested={side.sellerId === preview.suggestedKeepId}
                      onKeep={() => { setKeepId(side.sellerId === start.id ? start.id : otherId); merge.reset(); }}
                    />
                  ))}
                </div>
              </section>

              {/* 3. What carries over */}
              <section className="space-y-3">
                <h4 className="text-sm text-gray-300">What {namesOf(preview).keep} keeps</h4>
                <Choice
                  label="Address"
                  value={choices.address}
                  onChange={(v) => setChoices({ ...choices, address: v as SellerMergeChoices['address'] })}
                  options={[
                    { value: 'keep', label: preview.choices.address.keep ?? 'No address' },
                    { value: 'other', label: preview.choices.address.other ?? 'No address', disabled: !preview.choices.address.offered },
                  ]}
                />
                <Choice
                  label="Payout"
                  value={choices.payout}
                  onChange={(v) => setChoices({ ...choices, payout: v as SellerMergeChoices['payout'] })}
                  options={[
                    { value: 'keep', label: preview.choices.payout.keep ?? 'Not set' },
                    { value: 'other', label: preview.choices.payout.other ?? 'Not set', disabled: !preview.choices.payout.offered, why: preview.choices.payout.why },
                  ]}
                />
                {(preview.choices.businessName.keep || preview.choices.businessName.other) && (
                  <Choice
                    label="Business name"
                    value={choices.businessName}
                    onChange={(v) => setChoices({ ...choices, businessName: v as SellerMergeChoices['businessName'] })}
                    options={[
                      { value: 'keep', label: preview.choices.businessName.keep ?? 'None (a person)' },
                      ...(preview.choices.businessName.other ? [{ value: 'other', label: preview.choices.businessName.other }] : []),
                      ...(preview.choices.businessName.keep ? [{ value: 'none', label: 'None (a person)' }] : []),
                    ]}
                  />
                )}
              </section>

              {/* 4. What happens */}
              <section className="space-y-2">
                <h4 className="text-sm text-gray-300">What happens</h4>
                <ul className="text-sm text-gray-300 list-disc pl-5 space-y-1">
                  <li>{movesText(preview)} move from {namesOf(preview).other} to {namesOf(preview).keep}.</li>
                  {preview.itemsBySwap.filter((s) => s.other > 0).map((s) => (
                    <li key={s.swapId}>{s.title}: {s.other} item{s.other === 1 ? '' : 's'} join {s.keep} already there.</li>
                  ))}
                  {preview.payoutLines.filter((l) => l.effect !== 'stays').map((l) => (
                    <li key={l.lineId} className={l.effect === 'blocks' ? 'text-red-300' : ''}>
                      {l.seller === 'keep' ? namesOf(preview).keep : namesOf(preview).other} in {l.runLabel}: {LINE_EFFECT[l.effect]}.
                    </li>
                  ))}
                  {preview.paidSwaps.map((title) => (
                    <li key={title} className="text-amber-300">
                      {namesOf(preview).keep} was already paid for {title}: the moved items will show as Changed since paid, to settle by hand.
                    </li>
                  ))}
                  <li>{namesOf(preview).other} is retired. Their old links and anything an iPad still queues for them land on {namesOf(preview).keep}.</li>
                </ul>
                {preview.refusals.map((r) => (
                  <p key={r} className="text-sm text-red-300 bg-red-900/25 border border-red-800/60 rounded px-3 py-2">{r}</p>
                ))}
              </section>
            </>
          )}

          {merge.error && <p className="text-sm text-red-400">{(merge.error as Error).message}</p>}
        </div>

        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-700">
          <button
            type="button"
            disabled={!preview || preview.refusals.length > 0 || merge.isPending || isFetching}
            onClick={() => preview && confirmMerge(preview)}
            className="bg-red-700 hover:bg-red-600 text-white px-4 py-2 rounded text-sm font-medium disabled:opacity-40"
          >
            {merge.isPending ? 'Merging…' : preview ? `Merge into ${namesOf(preview).keep}` : 'Merge'}
          </button>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-sm px-3 py-2">Cancel</button>
        </div>
      </div>
    </div>
  );
}

/**
 * What to call each side in sentences. The same name twice is the usual case,
 * since they're one seller, so then each says which record it is.
 */
function namesOf(p: SellerMergePreviewResponse): { keep: string; other: string } {
  const same = p.keep.displayName.trim().toLowerCase() === p.other.displayName.trim().toLowerCase();
  if (!same) return { keep: p.keep.displayName, other: p.other.displayName };
  const kind = (s: SellerMergeSide) => (s.businessName ? 'the business' : 'the person');
  const distinct = kind(p.keep) !== kind(p.other);
  const label = (s: SellerMergeSide) =>
    distinct ? `${s.displayName} (${kind(s).replace('the ', '')})` : `${s.displayName} (added ${new Date(s.createdAt).toLocaleDateString()})`;
  return { keep: label(p.keep), other: label(p.other) };
}

function movesText(p: SellerMergePreviewResponse): string {
  const parts = [
    `${p.moves.items} item${p.moves.items === 1 ? '' : 's'}`,
    p.moves.receipts ? `${p.moves.receipts} receipt${p.moves.receipts === 1 ? '' : 's'}` : null,
    p.moves.printers ? `${p.moves.printers} printer assignment${p.moves.printers === 1 ? '' : 's'}` : null,
  ].filter(Boolean) as string[];
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
}

function SideCard({ side, kept, suggested, onKeep }: { side: SellerMergeSide; kept: boolean; suggested: boolean; onKeep: () => void }) {
  const row = (label: string, value: string | null, verified?: boolean) => (
    <div className="flex gap-2 text-xs">
      <span className="text-gray-500 w-16 shrink-0">{label}</span>
      <span className={value ? 'text-gray-200' : 'text-gray-600'}>
        {value ?? 'none'}{value && verified !== undefined ? (verified ? ' ✓' : ' (unverified)') : ''}
      </span>
    </div>
  );
  return (
    <button
      type="button"
      onClick={onKeep}
      aria-pressed={kept}
      className={`text-left rounded-lg border p-3 space-y-1 transition ${kept ? 'border-brand-500 bg-brand-900/15' : 'border-gray-700 hover:border-gray-500'}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-white font-medium">{side.displayName}</span>
        <span className={`text-xs ${kept ? 'text-brand-400' : 'text-gray-500'}`}>{kept ? 'Stays' : 'Retired'}{suggested ? ' · suggested' : ''}</span>
      </div>
      {side.businessName && <div className="text-xs text-gray-400">Business</div>}
      {row('Email', side.email, side.emailVerified)}
      {row('Phone', side.phone, side.phoneVerified)}
      {row('Payout', side.payout)}
      {row('Address', side.address)}
      {row('Items', String(side.items))}
      {row('Added', new Date(side.createdAt).toLocaleDateString())}
    </button>
  );
}

function Choice({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean; why?: string | null }[];
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs text-gray-500 mb-1">{label}</legend>
      {options.map((o) => (
        <label key={o.value} className={`flex items-start gap-2 text-sm ${o.disabled ? 'text-gray-600' : 'text-gray-200'}`}>
          <input type="radio" name={label} value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} className="mt-1" />
          <span>
            {o.label}
            {o.disabled && o.why && <span className="block text-xs text-gray-500">{o.why}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
