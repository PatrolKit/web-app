import { useState } from 'react';
import { Link, Navigate, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowLeft, faArrowsRotate, faChevronDown, faChevronRight, faLock, faLockOpen } from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { usd } from '../../lib/money';
import type { PayoutLine, PayoutRun } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import NewTabLink from '../../components/NewTabLink';
import AddSellersDialog from './payouts/AddSellersDialog';
import { compReasonLabel } from './comps/compView';
import {
  NOT_PAID, RUN_KIND_ICON, TONE, batchStatusText, dayText, feeRateText, fundingFor, methodLabel, soldAtText, sortSellers,
  statusView, whenText, type SortKey,
} from './payouts/payoutView';

/**
 * One payout run (Plan 52): its header (D13), the sellers in it (D10), and
 * everything that happens to their money. A run is checks or PayPal, starts
 * empty, and staff add the sellers it pays.
 */

type Filter = 'all' | 'open' | 'approved' | 'paid' | 'unclaimed' | 'notpaid' | 'flagged';
type Result = { ok: boolean; message: string } | null;

const SORT_KEY = 'patrolkit:payout-sort';
const smallButton = 'px-2.5 py-1 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200 disabled:opacity-40';

export default function PayoutRunPage() {
  const { runId } = useParams();
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const isAdmin = perms.has('ski_swap:admin');
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState<SortKey>(() => {
    try { return (localStorage.getItem(SORT_KEY) as SortKey) || 'name'; } catch { return 'name'; }
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<Result>(null);

  const key = ['ski-swap/payout-run', orgId, runId];
  const { data: run, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.skiSwap.getPayoutRun(orgId, runId!),
    enabled: !!orgId && !!runId,
  });
  const sentOrClosed = !!run?.batch?.id || run?.status === 'CLOSED';
  const { data: balance, isLoading: balanceLoading } = useQuery({
    queryKey: ['ski-swap/paypal-balance', orgId],
    queryFn: () => api.skiSwap.paypalBalance(orgId),
    enabled: !!orgId && run?.kind === 'PAYPAL' && !sentOrClosed,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ['ski-swap/payouts-summary'] });
  };
  /** Runs a change, then reads the run again; an error is shown, not thrown. */
  const act = useMutation({
    mutationFn: async ({ fn }: { fn: () => Promise<unknown>; done?: string }) => fn(),
    onSuccess: (_d, v) => { setResult(v.done ? { ok: true, message: v.done } : null); refresh(); },
    onError: (err) => { setResult({ ok: false, message: err instanceof ApiError ? err.message : 'That didn’t work. Try again.' }); refresh(); },
  });
  const run$ = (fn: () => Promise<unknown>, done?: string) => act.mutate({ fn, done });

  if (!perms.has('ski_swap:report')) return <Navigate to="/dashboard/ski-swap" replace />;
  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  if (error || !run) return <p className="text-gray-400">No such run. <Link to=".." className="underline">Back to payouts</Link></p>;

  const paypal = run.kind === 'PAYPAL';
  const isOpen = run.status === 'OPEN';
  const lines = run.lines;
  const toPay = lines.filter((l) => !l.frozen);
  const approved = lines.filter((l) => l.status === 'APPROVED');
  const waiting = lines.filter((l) => l.status === 'PENDING').length;
  const exported = lines.filter((l) => l.status === 'EXPORTED');
  const flaggedCount = lines.filter((l) => l.flags.length).length;
  const changedCount = lines.filter((l) => l.changedSincePaidCents !== 0).length;
  // PayPal must hold what the sellers get plus each payment's fee (an estimate at the rate in settings).
  const funding = fundingFor(toPay.map((l) => l.totals.netCents), run.feeRate);
  const sendable = fundingFor(approved.map((l) => l.approvedNetCents ?? 0), run.feeRate);
  const available = balance?.availableCents ?? null;
  const short = available !== null && available < sendable.total;
  const buildable = isOpen && !run.batch?.id && !run.awaitingAnswer;

  const matches = (l: PayoutLine, k: Filter) =>
    k === 'all' ? true
      : k === 'open' ? l.status === 'PENDING'
        : k === 'approved' ? l.status === 'APPROVED'
          : k === 'paid' ? l.status === 'SENT' || l.status === 'EXPORTED'
            : k === 'unclaimed' ? l.status === 'UNCLAIMED'
              : k === 'notpaid' ? NOT_PAID.includes(l.status)
                : l.flags.length > 0;
  const rows = lines.map((l) => ({ l, name: l.sellerName, netCents: l.totals.netCents, items: l.totals.items }));
  const shown = sortSellers(rows.filter((r) => matches(r.l, filter)), sort);
  const setSortKey = (k: SortKey) => { setSort(k); try { localStorage.setItem(SORT_KEY, k); } catch { /* remembered for this visit only */ } };
  const toggle = (id: string) => setOpen((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const downloadChecks = async () => {
    try {
      const blob = await api.skiSwap.checksCsv(orgId, run.id);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: `checks-${run.swapTitle.replace(/[^\w-]+/g, '-')}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Couldn’t download the spreadsheet.' });
    }
  };

  return (
    <div className="space-y-5 max-w-5xl">
      <Link to=".." className="text-sm text-gray-400 hover:text-white inline-flex items-center gap-1.5">
        <FontAwesomeIcon icon={faArrowLeft} className="h-3 w-3" /> All payout runs
      </Link>

      {/* D13: the header. */}
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-5 space-y-4">
        {/* The run's state comes first: open, and what's left to do; or closed, and nothing in it changes (D15). */}
        {isOpen ? (
          <div className="-mx-5 -mt-5 px-5 py-2.5 rounded-t-lg bg-green-900/25 border-b border-green-900/60 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-200">
            <FontAwesomeIcon icon={faLockOpen} className="text-green-400" aria-hidden />
            <span><strong className="text-green-300">Open</strong> since {whenText(run.createdAt)}.</span>
            <span className="text-gray-400">
              {run.batch?.id
                ? 'Sent. It closes once every payment is final: paid, failed, returned or cancelled.'
                : `Add sellers and approve each one, then ${paypal ? 'send' : 'close and export'}.`}
            </span>
          </div>
        ) : (
          <div className="-mx-5 -mt-5 px-5 py-2.5 rounded-t-lg bg-gray-700/40 border-b border-gray-700 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-200">
            <FontAwesomeIcon icon={faLock} className="text-gray-400" aria-hidden />
            <span><strong className="text-white">Closed</strong>{run.closedAt && ` ${whenText(run.closedAt)}`}.</span>
            <span className="text-gray-400">Sellers can’t be added, removed or approved.</span>
          </div>
        )}

        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-white font-semibold flex items-center gap-2">
              <FontAwesomeIcon icon={RUN_KIND_ICON[run.kind].icon} className={`h-4 w-4 ${RUN_KIND_ICON[run.kind].color}`} aria-hidden />
              {paypal ? 'PayPal Payouts run' : 'Check run'}
            </h2>
            <p className="text-gray-500 text-xs mt-0.5">
              {run.swapTitle} · {lines.length} {lines.length === 1 ? 'seller' : 'sellers'}
              {flaggedCount > 0 && <span className="text-amber-400"> · {flaggedCount} flagged</span>}
              {changedCount > 0 && <span className="text-red-400"> · {changedCount} changed since paid</span>}
            </p>
          </div>
          <div className="text-right">
            <p className="text-gray-500 text-xs">Total owed in this run</p>
            <p className="text-white font-semibold">{usd(lines.reduce((n, l) => n + l.totals.netCents, 0))}</p>
          </div>
        </div>

        {run.salesError && (
          <p className="text-sm text-red-200 bg-red-900/25 border border-red-800/60 rounded px-3 py-2">
            {run.salesError} Amounts and flags aren’t shown, and nobody can be approved, until Square can be read.
          </p>
        )}

        {/* D17: can PayPal cover this run? One line: yes or no. Fees are in the amount (hover for them). */}
        {paypal && buildable && toPay.length > 0 && (() => {
          const needed = (
            <span className="underline decoration-dotted cursor-help" title={`${usd(funding.toSellers)} to sellers + about ${usd(funding.fees)} in PayPal fees (${feeRateText(run.feeRate)})`}>
              {usd(funding.total)}
            </span>
          );
          return available === null ? (
            <p className="text-sm text-gray-300">
              ? Make sure PayPal has {needed}.{' '}
              <span className="text-gray-500">{balanceLoading ? 'Reading the balance…' : balance?.message ?? 'PatrolKit can’t read the balance.'}</span>
            </p>
          ) : available >= funding.total ? (
            <p className="text-sm text-green-400">✓ PayPal covers this run: {needed} needed, {usd(available)} available.</p>
          ) : (
            <p className="text-sm text-amber-300">✗ PayPal is {usd(funding.total - available)} short: {needed} needed, {usd(available)} available.</p>
          );
        })()}
        {!paypal && isOpen && toPay.length > 0 && (
          <p className="text-sm text-gray-300">Checks to write: <strong className="text-white">{toPay.length}</strong>, {usd(toPay.reduce((n, l) => n + l.totals.netCents, 0))}.</p>
        )}

        {paypal && isOpen && run.sendingLocked && (
          <p className="text-sm text-amber-200 bg-amber-900/20 border border-amber-800/60 rounded px-3 py-2">
            🔒 Sending is locked on this server. Runs can be built and approved; nothing goes to PayPal until it’s unlocked.
          </p>
        )}
        {run.batch?.reason && !run.batch.id && (
          <p className="text-sm text-red-200 bg-red-900/25 border border-red-800/60 rounded px-3 py-2">Not sent: {run.batch.reason}. Nothing was paid.</p>
        )}
        {result && <p className={`text-sm ${result.ok ? 'text-green-400' : 'text-red-300'}`}>{result.message}</p>}

        {/* D19: Send went out and PayPal didn't answer. */}
        {run.awaitingAnswer && (
          <p className="text-sm text-amber-200 bg-amber-900/20 border border-amber-800/60 rounded px-3 py-2">
            PayPal didn’t answer, so it may or may not have the batch. Nobody is paid twice: Send again re-sends the same batch, and PayPal ignores a batch it already has.
          </p>
        )}

        {/* D18: the run's one PayPal batch, and where everyone's payment stands. */}
        {run.batch?.id && <BatchBox run={run} />}

        {/* A closed check run: the spreadsheet the checks are written from. */}
        {!isOpen && !paypal && exported.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 border-t border-gray-800 pt-4">
            <button type="button" onClick={downloadChecks}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">Download checks (CSV)</button>
            <span className="text-sm text-gray-300">{exported.length} {exported.length === 1 ? 'check' : 'checks'}, {usd(exported.reduce((n, l) => n + l.totals.netCents, 0))}</span>
          </div>
        )}

        {isAdmin && isOpen && (
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-800 pt-4">
            {/* A run is one PayPal batch: once sent, it takes no one else (D18). */}
            {buildable && (
              <button type="button" onClick={() => setAdding(true)} className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">Add sellers</button>
            )}
            {paypal && run.awaitingAnswer && (
              <button type="button" disabled={run.sendingLocked || act.isPending}
                onClick={() => run$(() => api.skiSwap.sendPayoutRun(orgId, run.id, 0), 'Sent to PayPal.')}
                className="bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white px-3 py-2 rounded text-sm font-medium">Send again</button>
            )}
            {paypal && buildable && toPay.length > 0 && (
              <button type="button" disabled={!approved.length || waiting > 0 || run.sendingLocked || short || act.isPending}
                title={waiting ? 'Approve every seller in the run first' : run.sendingLocked ? 'Sending is locked on this server' : short ? 'PayPal doesn’t hold enough for the approved payments and their fees' : undefined}
                onClick={() => {
                  if (confirm(`Send ${usd(sendable.toSellers)} to ${approved.length} ${approved.length === 1 ? 'seller' : 'sellers'} through PayPal, about ${usd(sendable.total)} with PayPal’s fees? This can’t be undone.`)) {
                    run$(() => api.skiSwap.sendPayoutRun(orgId, run.id, approved.length), 'Sent to PayPal.');
                  }
                }}
                className="bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white px-3 py-2 rounded text-sm font-medium">
                Send to {approved.length} {approved.length === 1 ? 'seller' : 'sellers'}
              </button>
            )}
            {!paypal && lines.length > 0 && (
              <button type="button" disabled={!approved.length || waiting > 0 || act.isPending}
                title={waiting ? 'Approve every seller in the run first' : undefined}
                onClick={() => {
                  if (confirm(`Close this run and export ${approved.length} ${approved.length === 1 ? 'check' : 'checks'}, ${usd(approved.reduce((n, l) => n + (l.approvedNetCents ?? 0), 0))}? Every amount is final once it closes.`)) {
                    run$(() => api.skiSwap.closeCheckRun(orgId, run.id, approved.length), 'Closed. Download the spreadsheet to write the checks.');
                  }
                }}
                className="bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white px-3 py-2 rounded text-sm font-medium">
                Close and export
              </button>
            )}
            {buildable && waiting > 0 && lines.length > 0 && <span className="text-xs text-gray-400">{waiting} still to approve</span>}
            {paypal && run.batch?.id && (
              <button type="button" disabled={act.isPending} onClick={() => run$(() => api.skiSwap.reconcilePayoutRun(orgId, run.id), 'Checked with PayPal.')}
                className="text-sm px-3 py-2 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200 disabled:opacity-40">
                <FontAwesomeIcon icon={faArrowsRotate} className="mr-1.5 h-3.5 w-3.5" aria-hidden />Check with PayPal
              </button>
            )}
            {/* D15: a run closes itself once everyone is paid; only an empty one can be deleted. */}
            {lines.length === 0 && (
              <button type="button"
                onClick={() => {
                  if (!confirm('Delete this empty run?')) return;
                  api.skiSwap.deletePayoutRun(orgId, run.id).then(() => { refresh(); navigate('..'); })
                    .catch((err) => setResult({ ok: false, message: err instanceof ApiError ? err.message : 'Couldn’t delete it.' }));
                }}
                className="ml-auto text-sm px-3 py-2 rounded border border-gray-700 text-gray-400 hover:border-red-800 hover:bg-red-900/30 hover:text-red-200">Delete run</button>
            )}
          </div>
        )}
      </div>

      {/* D12: sort and filter. */}
      <div className="flex flex-wrap items-center gap-2">
        {([['all', 'All'], ['open', 'Needs review'], ['approved', 'Approved'], ['paid', paypal ? 'Paid' : 'Exported'], ...(paypal ? [['unclaimed', 'Unclaimed'], ['notpaid', 'Not paid']] : []), ['flagged', 'Flagged']] as [Filter, string][]).map(([k, label]) => {
          const n = lines.filter((l) => matches(l, k)).length;
          if ((k === 'unclaimed' || k === 'notpaid') && n === 0) return null;
          return (
            <button key={k} type="button" onClick={() => setFilter(k)}
              className={`text-xs px-2.5 py-1 rounded-full border ${filter === k ? 'bg-brand-600/15 text-brand-300 border-brand-700/60' : 'bg-surface-100 text-gray-400 border-gray-700 hover:text-white'}`}>
              {label} {n}
            </button>
          );
        })}
        <label className="ml-auto text-xs text-gray-400 flex items-center gap-2">
          Sort by
          <select value={sort} onChange={(e) => setSortKey(e.target.value as SortKey)} className="bg-surface-50 border border-gray-700 rounded px-2 py-1 text-sm text-white">
            <option value="name">Name</option>
            <option value="owed">Amount owed</option>
            <option value="items">Number of items</option>
          </select>
        </label>
      </div>

      <div className="space-y-2">
        {shown.map(({ l }) => (
          <SellerCard key={l.id} run={run} line={l} isAdmin={isAdmin} busy={act.isPending} timeZone={selectedSwap?.timeZone}
            open={open.has(l.id)} onToggle={() => toggle(l.id)} act={run$} />
        ))}
        {lines.length === 0 && <p className="text-gray-500 text-sm py-8 text-center">No sellers yet. Add the sellers this run pays.</p>}
        {lines.length > 0 && shown.length === 0 && <p className="text-gray-500 text-sm py-6 text-center">Nobody in that state.</p>}
      </div>

      {adding && (
        <AddSellersDialog orgId={orgId} run={run} onClose={() => setAdding(false)}
          onAdded={(n) => { setAdding(false); setResult({ ok: true, message: `Added ${n} ${n === 1 ? 'seller' : 'sellers'}.` }); refresh(); }} />
      )}
    </div>
  );
}

function BatchBox({ run }: { run: PayoutRun }) {
  const b = run.batch!;
  const sent = run.lines.filter((l) => l.frozen);
  const paidN = sent.filter((l) => l.status === 'SENT').length;
  const waitingN = sent.filter((l) => ['SENDING', 'UNCLAIMED', 'ONHOLD'].includes(l.status)).length;
  const notPaidN = sent.filter((l) => NOT_PAID.includes(l.status)).length;
  return (
    <div className="text-sm border border-gray-800 rounded px-3 py-2 space-y-1">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-gray-400">PayPal batch</span>
        <span className="font-mono text-gray-200">{b.id}</span>
        <span className={b.status === 'DENIED' || b.status === 'CANCELED' ? 'text-red-300' : 'text-gray-300'}>{batchStatusText(b.status)}</span>
        {b.feesCents !== null && <span className="text-gray-400">Fees {usd(b.feesCents)}</span>}
      </p>
      {b.reason && <p className="text-red-300">{b.reason} Nobody in this run was paid; add them to another run to pay them.</p>}
      <p className="text-gray-300">
        <span className="text-green-400">{paidN} paid</span>
        {waitingN > 0 && <span className="text-amber-300"> · {waitingN} waiting</span>}
        {notPaidN > 0 && <span className="text-red-300"> · {notPaidN} not paid</span>}
        <span className="text-gray-500"> of {sent.length}</span>
      </p>
    </div>
  );
}

function SellerCard({ run, line, isAdmin, busy, timeZone, open, onToggle, act }: {
  run: PayoutRun; line: PayoutLine; isAdmin: boolean; busy: boolean; timeZone?: string;
  open: boolean; onToggle: () => void; act: (fn: () => Promise<unknown>, done?: string) => void;
}) {
  const { orgId } = useOutletContext<SkiSwapContext>();
  const t = line.totals;
  const flags = line.flags;
  const diff = line.changedSincePaidCents;
  const status = statusView(line.status, run.kind);
  const where = run.kind === 'CHECK' ? line.destination ?? 'No address' : `${methodLabel(line.method)} · ${line.destination ?? 'no destination'}`;
  const editable = isAdmin && run.status === 'OPEN' && !line.frozen && !run.batch?.id && !run.awaitingAnswer;
  const bps = line.commissionBasisPoints;

  return (
    <div className={`bg-surface-50 border rounded-lg ${flags.length ? 'border-amber-700/60' : diff ? 'border-red-800/60' : 'border-gray-700'}`}>
      <div className="flex items-center gap-3 p-3">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={open ? 'Hide items' : 'Show items'} className="text-gray-500 hover:text-white w-5 shrink-0">
          <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} className="h-3.5 w-3.5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-white text-sm truncate">
            {line.sellerName}{line.business && <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-500">business</span>}
          </p>
          <p className="text-gray-500 text-xs truncate">{where} · {t.items} {t.items === 1 ? 'item' : 'items'}</p>
        </div>
        {/* Fixed-width slots, so the totals, statuses and buttons line up from card to card. */}
        <span className="w-20 shrink-0 text-right">
          {flags.length > 0 && <span className="text-xs px-2 py-0.5 rounded border border-amber-700/60 text-amber-300 whitespace-nowrap">⚑ {flags.length} {flags.length === 1 ? 'issue' : 'issues'}</span>}
        </span>
        <p className="text-white text-sm font-medium w-24 text-right shrink-0">{usd(t.netCents)}</p>
        <span className={`w-28 inline-flex items-center gap-1.5 text-xs shrink-0 ${TONE[status.tone].text}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${TONE[status.tone].dot}`} aria-hidden />{status.label}
        </span>
        <div className="w-44 shrink-0 flex items-center justify-end gap-2">
          {editable && line.status === 'PENDING' && (
            <button type="button" disabled={flags.length > 0 || busy} title={flags.length ? 'Resolve the issues first' : undefined}
              onClick={() => act(() => api.skiSwap.approvePayoutLine(orgId, run.id, line.id, true))}
              className={`w-28 text-xs py-1.5 rounded border ${flags.length ? 'border-gray-800 text-gray-600 cursor-not-allowed' : 'border-brand-600 bg-brand-600 hover:bg-brand-700 text-white'}`}>Approve</button>
          )}
          {editable && line.status === 'APPROVED' && (
            <button type="button" disabled={busy} onClick={() => act(() => api.skiSwap.approvePayoutLine(orgId, run.id, line.id, false))}
              className="w-28 text-xs py-1.5 rounded border border-gray-600 bg-surface-100 hover:bg-surface-200 text-gray-200">Unapprove</button>
          )}
          {editable && (
            <button type="button" disabled={busy} onClick={() => act(() => api.skiSwap.removePayoutSeller(orgId, run.id, line.sellerId))}
              className="text-xs px-2.5 py-1.5 rounded border border-gray-700 text-gray-400 hover:border-red-800 hover:bg-red-900/30 hover:text-red-200" title="Remove from this run">Remove</button>
          )}
        </div>
      </div>

      {/* Why it can't be approved, and where to fix it (D8). */}
      {flags.length > 0 && (
        <ul className="px-11 pb-2 space-y-0.5">
          {flags.map((f) => <li key={f.text} className="text-xs"><span className="text-amber-300">{f.text}.</span> <span className="text-gray-400">{f.fix}</span></li>)}
        </ul>
      )}
      {line.statusNote && !line.frozen && <p className="px-11 pb-2 text-xs text-red-300">{line.statusNote}</p>}
      {/* D19: an earlier run where PayPal didn't pay them. */}
      {line.notPaidBefore.map((e) => (
        <p key={e.runId} className="px-11 pb-1 text-xs text-gray-500">
          Earlier: not paid in the PayPal run of {dayText(e.createdAt)} ({statusView(e.status, 'PAYPAL').label.toLowerCase()}{e.reason ? `: ${e.reason.replace(/\.$/, '')}` : ''}).
        </p>
      ))}

      {/* D18: PayPal's answer for this payment. */}
      {run.kind === 'PAYPAL' && line.frozen && (
        <div className="px-11 pb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {line.status === 'SENT' ? (
            <span className="text-gray-400">
              Paid{line.paypal?.paidAt && ` ${whenText(line.paypal.paidAt)}`}
              {line.paypal?.transactionId && <> · Transaction <span className="font-mono text-gray-200">{line.paypal.transactionId}</span></>}
            </span>
          ) : (
            <span className={TONE[status.tone].text}>{line.statusNote && `${line.statusNote.replace(/\.?$/, '.')} `}{status.detail}</span>
          )}
          {/* D19: unclaimed is the one state with something to do here. */}
          {isAdmin && line.status === 'UNCLAIMED' && (
            <>
              <button type="button" disabled={busy || !!line.remindedAt} className={smallButton}
                title={line.remindedAt ? `Reminded ${whenText(line.remindedAt)}` : 'Email or text them a reminder to claim it'}
                onClick={() => act(() => api.skiSwap.remindPayoutSeller(orgId, run.id, line.id), `Reminded ${line.sellerName}.`)}>
                {line.remindedAt ? 'Reminded' : 'Remind them'}
              </button>
              <button type="button" disabled={busy || run.sendingLocked} className={smallButton}
                title={run.sendingLocked ? 'Sending is locked on this server' : undefined}
                onClick={() => {
                  if (confirm(`Cancel ${line.sellerName}’s payment at PayPal? The money comes back to PayPal now, and they’re marked Cancelled in this run. To pay them, add them to another run.`)) {
                    act(() => api.skiSwap.cancelPayoutPayment(orgId, run.id, line.id), 'Cancelled. The money is back in PayPal; add them to another run to pay them.');
                  }
                }}>Cancel payment</button>
            </>
          )}
          {line.paypal?.itemId && <span className="text-gray-500">PayPal item <span className="font-mono">{line.paypal.itemId}</span></span>}
        </div>
      )}

      {/* D9: changed since paid. */}
      {diff !== 0 && (
        <div className="px-11 pb-3 flex flex-wrap items-center gap-3 text-xs">
          <span className="text-red-300">{diff > 0 ? `Owed ${usd(diff)} more since paid` : `Paid ${usd(-diff)} more than now owed`}: settle it by hand.</span>
          {isAdmin && (
            <button type="button" disabled={busy}
              onClick={() => { const note = prompt('How was it settled?'); if (note?.trim()) act(() => api.skiSwap.settlePayoutLine(orgId, run.id, line.id, note.trim()), 'Marked settled.'); }}
              className={smallButton}>Mark settled…</button>
          )}
        </div>
      )}
      {line.settled && <p className="px-11 pb-2 text-xs text-gray-400">Settled by hand {dayText(line.settled.at)}: “{line.settled.note}”</p>}

      {/* D10: what was sold, and the arithmetic. */}
      {open && (
        <div className="border-t border-gray-800 px-4 py-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="pb-1.5 font-normal">SKU</th>
                <th className="pb-1.5 font-normal">Item</th>
                <th className="pb-1.5 font-normal">Sold</th>
                <th className="pb-1.5 font-normal">Receipt</th>
                <th className="pb-1.5 font-normal text-right">Price</th>
              </tr>
            </thead>
            <tbody>
              {line.items.map((x, i) => (
                <tr key={`${x.itemId}-${x.soldAt}-${i}`} className="border-t border-gray-800/60">
                  <td className="py-1.5 font-mono text-brand-400">{x.sku}</td>
                  <td className="py-1.5 text-gray-200">{x.name}{x.quantity > 1 && ` × ${x.quantity}`}{x.donated && <span className="ml-2 text-gray-500">donated</span>}</td>
                  <td className="py-1.5 text-gray-400 whitespace-nowrap">{soldAtText(x.soldAt, timeZone)}</td>
                  <td className="py-1.5 whitespace-nowrap">
                    {x.comp ? (
                      // A comp (Plan 53): no Square sale, so no receipt; it says why.
                      <span className="text-teal-300" title={x.comp.note}>Comp · {compReasonLabel(x.comp.reason)}</span>
                    ) : (
                      <>
                        {x.receipt && <span className="font-mono text-gray-300">#{x.receipt}</span>}{' '}
                        {x.saleUrl && <NewTabLink href={x.saleUrl} className="ml-3">View in Square</NewTabLink>}
                      </>
                    )}
                  </td>
                  <td className="py-1.5 text-right whitespace-nowrap">
                    <span className="text-white">{x.donated ? usd(0) : usd(x.priceCents * x.quantity)}</span>
                    {!x.donated && x.collectedCents !== x.priceCents * x.quantity && <span className="block text-gray-500">collected {usd(x.collectedCents)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {line.items.length === 0 && <p className="text-gray-500 text-xs py-2">No sales.</p>}
          <div className="mt-3 ml-auto w-full sm:w-72 text-sm space-y-1">
            <div className="flex justify-between text-gray-300"><span>{t.items} {t.items === 1 ? 'item' : 'items'} · Subtotal</span><span>{usd(t.grossCents)}</span></div>
            <div className="flex justify-between text-gray-400"><span>Patrol take ({bps / 100}%)</span><span>−{usd(t.commissionCents)}</span></div>
            <div className="flex justify-between text-white font-semibold border-t border-gray-700 pt-1"><span>Total</span><span>{usd(t.netCents)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
