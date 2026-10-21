import { useState } from 'react';
import { Link, Navigate, useNavigate, useOutletContext } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import PayoutsExport from './payouts/PayoutsExport';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock, faTriangleExclamation } from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { usd } from '../../lib/money';
import type { PayoutRunKind } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import NewTabLink from '../../components/NewTabLink';
import { RUN_KIND_ICON, dayText, whenText } from './payouts/payoutView';

/**
 * A swap's payouts (Plan 52): "Before you pay" at the top, sellers missing
 * details (D16), sellers PayPal didn't pay (D19) and Sales check issues (D8,
 * D14), gone when there are none; a new run by kind (D1); the runs; sellers
 * changed since paid (D9); discounts; and the donated sellers (D11).
 */
export default function PayoutsPage() {
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isAdmin = perms.has('ski_swap:admin');
  const [choosing, setChoosing] = useState(false);
  const [showGaps, setShowGaps] = useState(false);

  const { data: paypal } = useQuery({
    queryKey: ['ski-swap/paypal-status', orgId],
    queryFn: () => api.skiSwap.getPayPalStatus(orgId),
    enabled: !!orgId && isAdmin,
  });
  const { data, isLoading, error } = useQuery({
    queryKey: ['ski-swap/payouts-summary', orgId, selectedSwap?.id],
    queryFn: () => api.skiSwap.payoutsSummary(orgId, selectedSwap!.id),
    enabled: !!orgId && !!selectedSwap,
  });
  const create = useMutation({
    mutationFn: (kind: PayoutRunKind) => api.skiSwap.createPayoutRun(orgId, selectedSwap!.id, kind),
    onSuccess: ({ id }) => {
      qc.invalidateQueries({ queryKey: ['ski-swap/payouts-summary'] });
      navigate(id);
    },
  });

  if (!perms.has('ski_swap:report')) return <Navigate to="/dashboard/ski-swap" replace />;
  if (!selectedSwap) return <p className="text-gray-400">Pick a swap to see its payouts.</p>;

  const gaps = data?.missingDetails ?? [];
  const counts = {
    destination: gaps.filter((g) => g.key.startsWith('PAYPAL') || g.key.startsWith('VENMO')).length,
    address: gaps.filter((g) => g.key === 'ADDRESS').length,
    method: gaps.filter((g) => g.key === 'NO_METHOD').length,
  };
  const notPaid = data?.notPaid ?? [];
  const bySeller = data?.salesCheck.bySeller ?? [];
  const unmatched = data?.salesCheck.unmatched ?? [];
  const issues = bySeller.length + unmatched.length;
  const discounts = data?.discounts ?? [];

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-white font-semibold">Payouts</h2>
          <p className="text-gray-500 text-sm mt-0.5">What {selectedSwap.title} sold, and what each seller is owed for it.</p>
        </div>
        <PayoutsExport orgId={orgId} scope={{ swapId: selectedSwap.id }} defaultEmail={user?.email ?? ''} />
      </div>

      {isAdmin && paypal && !paypal.configured && (
        <p className="text-sm text-amber-200 bg-amber-900/20 border border-amber-800/60 rounded px-3 py-2">
          PayPal isn’t connected, so a PayPal run can be built but not sent. Check runs work as usual.{' '}
          <Link to="../config" className="underline">Connect PayPal</Link>
        </p>
      )}
      {isAdmin && paypal?.configured && paypal.environment === 'sandbox' && (
        <p className="text-xs text-gray-400 bg-surface-100 border border-gray-700 rounded px-3 py-2">
          PayPal is in <span className="text-white">sandbox</span>. Payouts sent from here reach nobody.
        </p>
      )}

      {isLoading && <p className="text-gray-400">Reading sales…</p>}
      {error && <p className="text-red-300 text-sm">{error instanceof ApiError ? error.message : 'Couldn’t load payouts.'}</p>}
      {data?.salesError && (
        <p className="text-sm text-red-200 bg-red-900/25 border border-red-800/60 rounded px-3 py-2">{data.salesError}</p>
      )}

      {/* D14, D16, D19: everything to fix before paying, in one place. Gone when there's nothing. */}
      {data && (gaps.length > 0 || issues > 0 || notPaid.length > 0) && (
        <div className="border border-amber-700/60 bg-amber-900/20 rounded-lg px-4 py-3 space-y-3 text-sm">
          <p className="text-amber-100 font-semibold flex items-center gap-2">
            <FontAwesomeIcon icon={faTriangleExclamation} className="text-amber-400" aria-hidden />Before you pay
          </p>

          {gaps.length > 0 && (
            <div className="space-y-1">
              <p className="text-amber-100">
                {gaps.length} {gaps.length === 1 ? 'seller is' : 'sellers are'} missing details.{' '}
                <span className="text-amber-200/70">Runs don’t offer them until they’re fixed.</span>
              </p>
              <ul className="list-disc pl-5 text-amber-200 space-y-0.5">
                {counts.destination > 0 && <li>{counts.destination} {counts.destination === 1 ? 'needs' : 'need'} a PayPal or Venmo destination</li>}
                {counts.address > 0 && <li>{counts.address} {counts.address === 1 ? 'needs' : 'need'} a mailing address</li>}
                {counts.method > 0 && <li>{counts.method} {counts.method === 1 ? 'hasn’t' : 'haven’t'} chosen how to be paid</li>}
              </ul>
              <div className="flex gap-4 text-xs pt-0.5">
                <button type="button" className="text-amber-300 underline" onClick={() => setShowGaps(!showGaps)}>{showGaps ? 'Hide them' : 'Show them'}</button>
                <Link to="/dashboard/ski-swap/sellers?show=unpayable" className="text-amber-300 underline">Show all on the Sellers page</Link>
              </div>
              {showGaps && (
                <ul className="divide-y divide-amber-900/50">
                  {gaps.map((g) => (
                    <li key={g.sellerId} className="py-1.5 flex flex-wrap items-baseline gap-x-3">
                      <span className="text-white">{g.name}</span>
                      <span className="text-amber-200">{g.problem}</span>
                      <span className="text-gray-400 text-xs">{g.fix}</span>
                      <Link to={`/dashboard/ski-swap/sellers?edit=${g.sellerId}`} className="text-brand-400 text-xs underline ml-auto">Edit seller</Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {notPaid.length > 0 && (
            <div className={`space-y-1 ${gaps.length ? 'border-t border-amber-900/50 pt-3' : ''}`}>
              <p className="text-amber-100">
                {notPaid.length} {notPaid.length === 1 ? 'seller wasn’t' : 'sellers weren’t'} paid by PayPal.{' '}
                <span className="text-amber-200/70">Check their details, then add them to a new run.</span>
              </p>
              <ul className="list-disc pl-5 text-amber-200 space-y-0.5">
                {notPaid.map((n) => (
                  <li key={n.sellerId}>
                    <span className="text-white">{n.name}</span> · {n.status === 'CANCELLED' ? 'cancelled' : n.status === 'RETURNED' ? 'returned' : 'failed'} in the
                    {' '}<Link to={n.runId} className="underline">run of {dayText(n.createdAt)}</Link>
                    {n.reason && <span className="text-amber-200/70"> · {n.reason.replace(/\.$/, '')}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {issues > 0 && (
            <div className={`space-y-1 ${gaps.length || notPaid.length ? 'border-t border-amber-900/50 pt-3' : ''}`}>
              <p className="text-amber-100">
                {issues} Sales check {issues === 1 ? 'issue' : 'issues'}.{' '}
                <span className="text-amber-200/70">A seller with one can’t be approved until it’s settled.</span>
              </p>
              <ul className="list-disc pl-5 text-amber-200 space-y-0.5">
                {bySeller.map((i, n) => (
                  <li key={`${i.sellerId}-${n}`}><span className="text-white">{i.name}</span> · {i.sku ? `${i.sku}: ` : ''}{i.text}</li>
                ))}
                {unmatched.map((u, n) => (
                  <li key={`u-${n}`}>
                    {u.receipt ? `#${u.receipt} ` : ''}matched no ticket · {u.name || 'a sale'} · {usd(u.collectedCents)}{' '}
                    <span className="text-amber-200/70">· nobody is paid for it</span>
                    {u.saleUrl && <NewTabLink href={u.saleUrl} className="ml-2 text-xs">View in Square</NewTabLink>}
                  </li>
                ))}
              </ul>
              <Link to="/dashboard/ski-swap/verify" className="text-xs text-amber-300 underline">Open Sales check</Link>
            </div>
          )}
        </div>
      )}

      {/* D1: a run is checks or PayPal, and starts empty. */}
      {data && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-white font-medium">Runs</h3>
            {isAdmin && (
              <button type="button" onClick={() => setChoosing(true)} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">New run</button>
            )}
          </div>
          {choosing && (
            <div className="fixed inset-0 z-40 bg-black/60 flex items-start justify-center p-4 overflow-y-auto" onClick={() => setChoosing(false)}
              onKeyDown={(e) => { if (e.key === 'Escape') setChoosing(false); }}>
              <div role="dialog" aria-modal="true" aria-labelledby="new-run-title" className="w-full max-w-lg bg-surface-50 border border-gray-700 rounded-lg mt-24"
                onClick={(e) => e.stopPropagation()}>
                <div className="px-5 py-4 border-b border-gray-800">
                  <h3 id="new-run-title" className="text-white font-semibold">New run</h3>
                  <p className="text-xs text-gray-400 mt-1">What kind of run? It starts empty; you add the sellers it pays.</p>
                </div>
                <div className="p-5 grid sm:grid-cols-2 gap-3">
                  {(['PAYPAL', 'CHECK'] as PayoutRunKind[]).map((k, i) => (
                    <button key={k} type="button" autoFocus={i === 0} disabled={create.isPending} onClick={() => create.mutate(k)}
                      className="text-left border border-gray-700 hover:border-brand-600 focus:border-brand-600 focus:outline-none rounded-lg p-3 bg-surface-100 disabled:opacity-50">
                      <p className="text-white font-medium flex items-center gap-2">
                        <FontAwesomeIcon icon={RUN_KIND_ICON[k].icon} className={`h-5 w-5 ${RUN_KIND_ICON[k].color}`} aria-hidden />
                        {k === 'PAYPAL' ? 'Pay through PayPal' : 'Pay by check'}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        {k === 'PAYPAL' ? 'Sellers paid by PayPal or Venmo.' : 'Sellers paid by check.'}{' '}
                        {data.ready[k]} ready to add.
                      </p>
                    </button>
                  ))}
                </div>
                {create.error && <p className="px-5 pb-2 text-sm text-red-300">{create.error instanceof ApiError ? create.error.message : 'Couldn’t start a run.'}</p>}
                <div className="px-5 py-3 border-t border-gray-800 flex justify-end">
                  <button type="button" onClick={() => setChoosing(false)}
                    className="text-sm px-3 py-1.5 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Cancel</button>
                </div>
              </div>
            </div>
          )}
          {data.runs.length === 0 ? (
            <p className="text-sm text-gray-500">No runs yet.</p>
          ) : (
            <ul className="space-y-2">
              {data.runs.map((r) => (
                <li key={r.id}>
                  <Link to={r.id} className={`flex items-center gap-3 border rounded-lg px-4 py-3 ${r.status === 'OPEN' ? 'border-gray-700 bg-surface-50 hover:bg-surface-100' : 'border-gray-800 bg-surface-50/40 hover:bg-surface-100/60 opacity-70'}`}>
                    <span className={`text-xs px-2 py-0.5 rounded border shrink-0 ${r.kind === 'PAYPAL' ? 'border-blue-800/60 text-blue-300' : 'border-gray-600 text-gray-300'}`}>
                      <FontAwesomeIcon icon={RUN_KIND_ICON[r.kind].icon} className="mr-1.5" aria-hidden />{r.kind === 'PAYPAL' ? 'PayPal' : 'Checks'}
                    </span>
                    <span className="text-white text-sm">{whenText(r.createdAt)}</span>
                    <span className="text-gray-400 text-xs">{r.lineCount} {r.lineCount === 1 ? 'seller' : 'sellers'}{r.flaggedCount ? ` · ${r.flaggedCount} flagged` : ''}</span>
                    <span className="ml-auto text-white text-sm font-medium">{usd(r.totalNetCents)}</span>
                    <span className="w-20 text-right shrink-0">
                      {r.status === 'OPEN'
                        ? <span className="inline-flex items-center gap-1.5 text-xs text-green-400"><span className="h-1.5 w-1.5 rounded-full bg-green-500" aria-hidden />Open</span>
                        : <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-200"><FontAwesomeIcon icon={faLock} className="h-2.5 w-2.5" aria-hidden />Closed</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Plan 53 D10: comps, for the record. */}
      {!!data?.comps.count && (
        <p className="text-sm text-gray-300">
          {data.comps.count} comped {data.comps.count === 1 ? 'item' : 'items'}, {usd(data.comps.totalCents)} at list price, with no sale in Square.{' '}
          <Link to="/dashboard/ski-swap/adjustments/comps" className="text-brand-400 underline">See comps</Link>
        </p>
      )}

      {/* D9: changed since paid, settled by hand. */}
      {!!data?.changedSincePaid.length && (
        <div className="border border-red-800/60 bg-red-900/15 rounded-lg px-4 py-3 space-y-1">
          <p className="text-sm text-red-200 font-medium">Changed since paid</p>
          {data.changedSincePaid.map((c) => (
            <p key={`${c.runId}-${c.sellerId}`} className="text-sm text-gray-300">
              <Link to={c.runId} className="text-white underline">{c.name}</Link>:{' '}
              {c.diffCents > 0 ? `owed ${usd(c.diffCents)} more since paid` : `paid ${usd(-c.diffCents)} more than now owed`}. Settle it by hand, then mark it settled on their card.
            </p>
          ))}
        </div>
      )}

      {/* D14: discounts are paid at the listed price; for the record, nothing to fix. */}
      {discounts.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-white font-medium">Discounts</h3>
          <div className="border border-gray-700 bg-surface-50 rounded-lg px-4 py-3 text-sm">
            <p className="text-gray-200">
              {discounts.length} {discounts.length === 1 ? 'sale' : 'sales'} below the listed price, {usd(discounts.reduce((n, d) => n + d.listedCents - d.collectedCents, 0))} in all. Sellers are paid the listed price.
            </p>
            <ul className="mt-1 text-xs text-gray-400">
              {discounts.map((d, n) => <li key={`${d.sku}-${n}`}>{d.sku} {d.name} · {d.sellerName} · listed {usd(d.listedCents)}, collected {usd(d.collectedCents)}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* D11: donated, for the record. */}
      {!!data?.donated.length && (
        <div className="space-y-2">
          <h3 className="text-white font-medium">Donated to the patrol</h3>
          <ul className="border border-gray-700 bg-surface-50 rounded-lg divide-y divide-gray-800 text-sm">
            {data.donated.map((d) => (
              <li key={d.sellerId} className="px-4 py-2 flex justify-between">
                <span className="text-gray-200">{d.name} <span className="text-xs text-gray-500">· {d.items} {d.items === 1 ? 'item' : 'items'}</span></span>
                <span className="text-gray-300">{usd(d.grossCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
