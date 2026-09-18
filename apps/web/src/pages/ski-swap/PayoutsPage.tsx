import { useOutletContext, Navigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowsRotate,
  faBell,
  faMoneyCheckDollar,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { usd } from '../../lib/money';
import type { SkiSwapContext } from './SkiSwapLayout';
import type { PayoutRunSummary } from '../../lib/api.types';

/**
 * A swap's payout runs (Plan 25 §5).
 *
 * The list is deliberately thin. All the work happens inside a run, and the
 * only decisions here are "start one" and "open the one we started".
 */
export default function PayoutsPage() {
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const isAdmin = perms.has('ski_swap:admin');

  const { data: paypal } = useQuery({
    queryKey: ['ski-swap/paypal-status', orgId],
    queryFn: () => api.skiSwap.getPayPalStatus(orgId),
    enabled: !!orgId,
  });

  const { data: runs, isLoading } = useQuery({
    queryKey: ['ski-swap/payout-runs', orgId, selectedSwap?.id],
    queryFn: () => api.skiSwap.listPayoutRuns(orgId, selectedSwap?.id),
    enabled: !!orgId && !!selectedSwap,
  });

  const create = useMutation({
    mutationFn: () => api.skiSwap.createPayoutRun(orgId, selectedSwap!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/payout-runs', orgId] }),
  });

  const reconcile = useMutation({
    mutationFn: () => api.skiSwap.reconcilePayouts(orgId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/payout-runs', orgId] }),
  });

  const nudge = useMutation({ mutationFn: () => api.skiSwap.nudgePayouts(orgId) });

  if (!perms.has('ski_swap:report')) return <Navigate to="/dashboard/ski-swap" replace />;
  if (!selectedSwap) return <p className="text-gray-400">Pick a swap to see its payouts.</p>;

  const openRun = runs?.find((r) => r.status !== 'CLOSED');

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-white font-semibold">Payouts</h2>
          <p className="text-gray-500 text-sm mt-0.5">
            What {selectedSwap.title} sold, and what each seller is owed for it.
          </p>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => reconcile.mutate()}
              disabled={reconcile.isPending}
              title="Ask PayPal what happened to everything still in flight"
              className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 text-sm px-3 py-1.5 rounded"
            >
              <FontAwesomeIcon icon={faArrowsRotate} className="mr-1.5 h-3.5 w-3.5" />
              {reconcile.isPending ? 'Checking…' : 'Refresh from PayPal'}
            </button>
            <button
              onClick={() => nudge.mutate()}
              disabled={nudge.isPending}
              title="Email or text sellers whose payout is still unclaimed"
              className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 text-sm px-3 py-1.5 rounded"
            >
              <FontAwesomeIcon icon={faBell} className="mr-1.5 h-3.5 w-3.5" />
              {nudge.isPending ? 'Sending…' : 'Nudge unclaimed'}
            </button>
          </div>
        )}
      </div>

      {(reconcile.data || nudge.data) && (
        <p className="text-sm text-gray-400">
          {reconcile.data && `Re-read ${reconcile.data.reconciled} of ${reconcile.data.batches} batches from PayPal. `}
          {nudge.data && `Nudges: ${nudge.data.sent} sent, ${nudge.data.suppressed} suppressed, ${nudge.data.failed} failed.`}
        </p>
      )}

      {isAdmin && paypal && !paypal.configured && (
        <div className="flex items-start gap-3 bg-yellow-900/30 border border-yellow-700 rounded-lg p-4">
          <span className="text-yellow-400 text-lg leading-none">⚠</span>
          <p className="text-yellow-200 text-sm">
            PayPal is not connected, so electronic payouts cannot be sent. You can still build a run
            and pay everybody by check.{' '}
            <Link to="../config" className="underline">Connect PayPal</Link>
          </p>
        </div>
      )}

      {isAdmin && paypal?.configured && paypal.environment === 'sandbox' && (
        <p className="text-xs text-gray-400 bg-surface-100 border border-gray-700 rounded px-3 py-2">
          PayPal is in <span className="text-white">sandbox</span>. Payouts sent from here reach
          nobody.
        </p>
      )}

      {isLoading && <p className="text-gray-400">Loading…</p>}

      {!isLoading && !runs?.length && (
        <div className="bg-surface-50 border border-gray-700 rounded-lg p-8 text-center space-y-3">
          <FontAwesomeIcon icon={faMoneyCheckDollar} className="h-8 w-8 text-gray-600" />
          <p className="text-gray-300">No payout run yet for this swap.</p>
          <p className="text-gray-500 text-sm max-w-md mx-auto">
            Starting one reads the completed sales from Square and works out what each seller is
            owed. Nothing is sent until somebody approves it.
          </p>
          {isAdmin && <StartButton pending={create.isPending} error={create.error} onStart={() => create.mutate()} />}
        </div>
      )}

      {!!runs?.length && (
        <div className="space-y-3">
          {runs.map((run) => <RunRow key={run.id} run={run} />)}
          {isAdmin && !openRun && (
            <div className="pt-2">
              <StartButton pending={create.isPending} error={create.error} onStart={() => create.mutate()} />
              <p className="text-xs text-gray-500 mt-1.5">
                A new run reads the sales again from the start of the swap.
              </p>
            </div>
          )}
          {isAdmin && openRun && (
            <p className="text-xs text-gray-500 pt-1">
              Close the open run before starting another — two runs over the same sales would pay
              everybody twice.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function StartButton({
  pending, error, onStart,
}: { pending: boolean; error: unknown; onStart: () => void }) {
  return (
    <div className="space-y-1.5">
      <button
        onClick={onStart}
        disabled={pending}
        className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
      >
        {pending ? 'Reading sales…' : 'Start a payout run'}
      </button>
      {!!error && (
        <p className="text-red-400 text-sm">
          {error instanceof ApiError ? error.message : 'Could not start a run'}
        </p>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  REVIEW: 'bg-brand-600/15 text-brand-400 border-brand-700/50',
  DRAFT: 'bg-surface-100 text-gray-300 border-gray-700',
  CLOSED: 'bg-surface-100 text-gray-500 border-gray-700',
};

function RunRow({ run }: { run: PayoutRunSummary }) {
  // Only what is still waiting on a person. A closed-out run showing "SENT 40"
  // says nothing; "3 need attention" is the whole reason to open it.
  const waiting =
    (run.byStatus.PENDING ?? 0) + (run.byStatus.UNCLAIMED ?? 0) +
    (run.byStatus.FAILED ?? 0) + (run.byStatus.RETURNED ?? 0);

  return (
    <Link
      to={run.id}
      className="block bg-surface-50 border border-gray-700 hover:border-gray-600 rounded-lg p-4 transition"
    >
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-xs px-2 py-0.5 rounded border ${STATUS_TONE[run.status] ?? STATUS_TONE.DRAFT}`}>
              {run.status === 'REVIEW' ? 'Open' : run.status === 'CLOSED' ? 'Closed' : 'Draft'}
            </span>
            <span className="text-white text-sm">
              {new Date(run.createdAt).toLocaleDateString(undefined, {
                month: 'short', day: 'numeric', year: 'numeric',
              })}
            </span>
          </div>
          <p className="text-gray-500 text-xs mt-1">
            {run.lineCount} {run.lineCount === 1 ? 'seller' : 'sellers'}
            {waiting > 0 && (
              <span className="text-amber-400">
                {' '}· {waiting} {waiting === 1 ? 'needs' : 'need'} attention
              </span>
            )}
          </p>
        </div>
        <span className="text-white font-medium shrink-0">{usd(run.totalNetCents)}</span>
      </div>
    </Link>
  );
}
