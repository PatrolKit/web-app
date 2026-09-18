import { useMemo, useState } from 'react';
import { useOutletContext, useParams, Link, Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowLeft,
  faChevronDown,
  faChevronRight,
  faFileArrowDown,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { usd } from '../../lib/money';
import type { SkiSwapContext } from './SkiSwapLayout';
import type { PayoutLine, PayoutLineStatus, PayoutRun } from '../../lib/api.types';

/**
 * Reviewing, approving and sending one payout run (Plan 25 §5–§10).
 *
 * The screen a person is looking at when they authorise money leaving an
 * account, so it is built around being able to check rather than around being
 * quick: every line opens onto the items it was calculated from, and the send
 * button says the total and the count out loud before it does anything.
 */

const STATUS_LABEL: Record<PayoutLineStatus, string> = {
  PENDING: 'Needs review',
  APPROVED: 'Approved',
  SENDING: 'Sending',
  SENT: 'Paid',
  UNCLAIMED: 'Unclaimed',
  FAILED: 'Failed',
  RETURNED: 'Returned',
  PAID_BY_CHECK: 'Check sent',
  DONATED: 'Donated',
  BELOW_MINIMUM: 'Under minimum',
};

const STATUS_TONE: Record<PayoutLineStatus, string> = {
  PENDING: 'bg-surface-100 text-gray-300 border-gray-700',
  APPROVED: 'bg-brand-600/15 text-brand-400 border-brand-700/50',
  SENDING: 'bg-blue-500/10 text-blue-300 border-blue-800/50',
  SENT: 'bg-green-500/10 text-green-400 border-green-800/50',
  UNCLAIMED: 'bg-amber-500/10 text-amber-300 border-amber-700/50',
  FAILED: 'bg-red-500/10 text-red-400 border-red-800/50',
  RETURNED: 'bg-red-500/10 text-red-400 border-red-800/50',
  PAID_BY_CHECK: 'bg-green-500/10 text-green-400 border-green-800/50',
  DONATED: 'bg-surface-100 text-gray-400 border-gray-700',
  BELOW_MINIMUM: 'bg-surface-100 text-gray-400 border-gray-700',
};

type Tab = 'payouts' | 'checks' | 'discounts';

export default function PayoutRunPage() {
  const { orgId, perms } = useOutletContext<SkiSwapContext>();
  const { runId = '' } = useParams();
  const qc = useQueryClient();
  const isAdmin = perms.has('ski_swap:admin');
  const [tab, setTab] = useState<Tab>('payouts');

  const { data: run, isLoading } = useQuery({
    queryKey: ['ski-swap/payout-run', orgId, runId],
    queryFn: () => api.skiSwap.getPayoutRun(orgId, runId),
    enabled: !!orgId && !!runId,
    // While anything is in flight, keep asking: SENDING resolves through a
    // webhook that arrives whenever it arrives.
    refetchInterval: (query) =>
      query.state.data?.lines.some((l) => l.status === 'SENDING') ? 5_000 : false,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['ski-swap/payout-run', orgId, runId] });
    qc.invalidateQueries({ queryKey: ['ski-swap/payout-runs', orgId] });
  };

  if (!perms.has('ski_swap:report')) return <Navigate to="/dashboard/ski-swap" replace />;
  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  if (!run) return <p className="text-gray-400">That payout run could not be found.</p>;

  const checkCount = run.lines.filter((l) => l.method === 'CHECK').length;

  return (
    <div className="space-y-6">
      <div>
        <Link to=".." className="text-sm text-gray-400 hover:text-white">
          <FontAwesomeIcon icon={faArrowLeft} className="mr-1.5 h-3 w-3" />
          All payout runs
        </Link>
      </div>

      <RunHeader run={run} isAdmin={isAdmin} onChanged={invalidate} />

      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <TabButton active={tab === 'payouts'} onClick={() => setTab('payouts')}>
          Payouts
        </TabButton>
        <TabButton active={tab === 'checks'} onClick={() => setTab('checks')}>
          Checks{checkCount > 0 && <span className="ml-1.5 text-gray-500">{checkCount}</span>}
        </TabButton>
        <TabButton active={tab === 'discounts'} onClick={() => setTab('discounts')}>
          Discounts
        </TabButton>
      </nav>

      {tab === 'payouts' && (
        <>
          <UnmatchedSales run={run} />
          <LinesTable run={run} isAdmin={isAdmin} onChanged={invalidate} />
        </>
      )}
      {tab === 'checks' && <ChecksTab run={run} isAdmin={isAdmin} onChanged={invalidate} />}
      {tab === 'discounts' && <DiscountsTab orgId={orgId} runId={run.id} />}
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-sm px-3 py-1.5 rounded transition ${
        active ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

// ─── Header: the totals, and the two buttons that change the world ────────────

function RunHeader({
  run, isAdmin, onChanged,
}: { run: PayoutRun; isAdmin: boolean; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const { orgId } = useOutletContext<SkiSwapContext>();

  const sendable = run.lines.filter(
    (l) => l.status === 'APPROVED' && (l.method === 'PAYPAL' || l.method === 'VENMO'),
  );
  const sendableTotal = sendable.reduce((sum, l) => sum + l.netCents, 0);
  const inFlight = run.lines.some((l) => l.status === 'SENDING');

  const send = useMutation({
    mutationFn: () => api.skiSwap.sendPayoutRun(orgId, run.id, sendable.length),
    onSuccess: () => { setConfirming(false); onChanged(); },
  });

  const close = useMutation({
    mutationFn: () => api.skiSwap.closePayoutRun(orgId, run.id),
    onSuccess: onChanged,
  });

  return (
    <div className="bg-surface-50 border border-gray-700 rounded-lg p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-white font-semibold">{run.swapTitle}</h2>
          <p className="text-gray-500 text-xs mt-0.5">
            Sales from {new Date(run.salesFrom).toLocaleDateString()} to{' '}
            {new Date(run.salesTo).toLocaleDateString()}
            {run.status === 'CLOSED' && run.closedAt &&
              ` · closed ${new Date(run.closedAt).toLocaleDateString()}`}
          </p>
        </div>

        <div className="flex items-baseline gap-6 text-sm">
          <div>
            <p className="text-gray-500 text-xs">Sold</p>
            <p className="text-white">{usd(run.totals.grossCents)}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">
              Patrol ({run.commissionBasisPoints / 100}%)
            </p>
            <p className="text-gray-300">−{usd(run.totals.commissionCents)}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs">Payouts</p>
            <p className="text-white font-semibold">{usd(run.totals.netCents)}</p>
          </div>
        </div>
      </div>

      {isAdmin && run.status !== 'CLOSED' && (
        <div className="border-t border-gray-800 pt-4 space-y-3">
          {inFlight && (
            <p className="text-sm text-blue-300">
              Some payouts are still with PayPal. Sending again is safe — it re-sends the same
              batch, which PayPal will not pay twice.
            </p>
          )}

          {!confirming && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => setConfirming(true)}
                disabled={!sendable.length && !inFlight}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
              >
                {inFlight
                  ? 'Retry sending'
                  : `Send ${sendable.length} payout${sendable.length === 1 ? '' : 's'}`}
              </button>
              {!sendable.length && !inFlight && (
                <span className="text-xs text-gray-500">
                  Approve some payouts first.
                </span>
              )}
              <button
                onClick={() => { if (confirm('Close this run? Nothing further can be approved or sent against it.')) close.mutate(); }}
                disabled={close.isPending}
                className="text-sm text-gray-400 hover:text-white ml-auto"
              >
                Close run
              </button>
            </div>
          )}

          {/* The confirmation says the amount and the count in words, because
              this is the last screen before money leaves somebody's account. */}
          {confirming && (
            <div className="border border-amber-700/50 bg-amber-500/5 rounded-lg p-4 space-y-3">
              <p className="text-sm text-amber-100">
                Send <strong>{usd(sendableTotal)}</strong> to{' '}
                <strong>{sendable.length}</strong> {sendable.length === 1 ? 'seller' : 'sellers'}
                {' '}through PayPal. This cannot be undone.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => send.mutate()}
                  disabled={send.isPending}
                  className="bg-amber-600 hover:bg-amber-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
                >
                  {send.isPending ? 'Sending…' : 'Yes, send the payouts'}
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  className="text-gray-400 hover:text-white text-sm px-3 py-2"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {send.isError && (
            <p className="text-sm text-red-400">
              {send.error instanceof ApiError ? send.error.message : 'The send failed'}
            </p>
          )}
          {close.isError && (
            <p className="text-sm text-red-400">
              {close.error instanceof ApiError ? close.error.message : 'Could not close the run'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Sales this run could not attribute to anybody (§12).
 *
 * Almost always something rung up by hand at the register, or another swap's
 * stock at the same Square location. Shown rather than logged, because it is
 * money the org took and nobody is being paid for it — and nobody goes looking
 * for a number they were never told about.
 */
function UnmatchedSales({ run }: { run: PayoutRun }) {
  const [open, setOpen] = useState(false);
  if (!run.unmatchedSales?.length) return null;

  const total = run.unmatchedSales.reduce((sum, s) => sum + s.collectedCents, 0);

  return (
    <div className="rounded-lg border border-amber-800/50 bg-amber-500/5 p-4 space-y-3">
      <div className="flex items-start gap-3">
        <span className="text-amber-400 leading-none">⚠</span>
        <div className="flex-1 text-sm text-amber-100">
          <p>
            {run.unmatchedSales.length}{' '}
            {run.unmatchedSales.length === 1 ? 'sale' : 'sales'} totalling{' '}
            <strong>{usd(total)}</strong> matched no item in this swap, so nobody is being paid
            for {run.unmatchedSales.length === 1 ? 'it' : 'them'}.
          </p>
          <p className="text-amber-200/70 text-xs mt-1">
            Usually something rung up by hand, or another swap's stock at the same Square
            location.
          </p>
        </div>
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-amber-300 hover:text-amber-200 shrink-0"
        >
          {open ? 'Hide' : 'Show orders'}
        </button>
      </div>

      {open && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-amber-200/60 text-left">
              <th className="pb-1.5 font-normal">Square order</th>
              <th className="pb-1.5 font-normal">Catalog item</th>
              <th className="pb-1.5 font-normal text-right">Collected</th>
            </tr>
          </thead>
          <tbody>
            {run.unmatchedSales.map((sale, i) => (
              <tr key={`${sale.orderId}-${i}`} className="border-t border-amber-800/30">
                <td className="py-1.5 font-mono text-amber-100/90">{sale.orderId}</td>
                <td className="py-1.5 font-mono text-amber-200/60">{sale.variationId}</td>
                <td className="py-1.5 text-right text-amber-100">{usd(sale.collectedCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── The lines ───────────────────────────────────────────────────────────────

function LinesTable({
  run, isAdmin, onChanged,
}: { run: PayoutRun; isAdmin: boolean; onChanged: () => void }) {
  const { orgId } = useOutletContext<SkiSwapContext>();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<PayoutLineStatus | 'ALL'>('ALL');

  const electronic = run.lines.filter((l) => l.method === 'PAYPAL' || l.method === 'VENMO');
  const pending = electronic.filter((l) => l.status === 'PENDING');

  const approve = useMutation({
    mutationFn: (v: { lineIds: string[]; approved: boolean }) =>
      api.skiSwap.approvePayoutLines(orgId, run.id, v.lineIds, v.approved),
    onSuccess: onChanged,
  });

  const cancel = useMutation({
    mutationFn: (lineId: string) => api.skiSwap.cancelUnclaimedPayout(orgId, run.id, lineId),
    onSuccess: onChanged,
  });

  const counts = useMemo(() => {
    const out = new Map<PayoutLineStatus, number>();
    for (const l of run.lines) out.set(l.status, (out.get(l.status) ?? 0) + 1);
    return out;
  }, [run.lines]);

  const shown = filter === 'ALL' ? run.lines : run.lines.filter((l) => l.status === filter);

  function toggle(id: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip active={filter === 'ALL'} onClick={() => setFilter('ALL')}>
          All {run.lines.length}
        </FilterChip>
        {([...counts.entries()] as [PayoutLineStatus, number][])
          .sort((a, b) => b[1] - a[1])
          .map(([status, count]) => (
            <FilterChip key={status} active={filter === status} onClick={() => setFilter(status)}>
              {STATUS_LABEL[status]} {count}
            </FilterChip>
          ))}

        {isAdmin && run.status !== 'CLOSED' && pending.length > 0 && (
          <button
            onClick={() => approve.mutate({ lineIds: pending.map((l) => l.id), approved: true })}
            disabled={approve.isPending}
            className="ml-auto bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-white text-sm px-3 py-1.5 rounded"
          >
            Approve all {pending.length} remaining
          </button>
        )}
      </div>

      {approve.isError && (
        <p className="text-sm text-red-400">
          {approve.error instanceof ApiError ? approve.error.message : 'Could not save that'}
        </p>
      )}

      <div className="space-y-2">
        {shown.map((line) => (
          <LineRow
            key={line.id}
            line={line}
            open={open.has(line.id)}
            onToggle={() => toggle(line.id)}
            isAdmin={isAdmin && run.status !== 'CLOSED'}
            onApprove={(approved) => approve.mutate({ lineIds: [line.id], approved })}
            onCancel={() => cancel.mutate(line.id)}
            busy={approve.isPending || cancel.isPending}
          />
        ))}
        {!shown.length && (
          <p className="text-gray-500 text-sm py-6 text-center">Nothing in that state.</p>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-full border transition ${
        active
          ? 'bg-brand-600/15 text-brand-300 border-brand-700/60'
          : 'bg-surface-100 text-gray-400 border-gray-700 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function LineRow({
  line, open, onToggle, isAdmin, onApprove, onCancel, busy,
}: {
  line: PayoutLine;
  open: boolean;
  onToggle: () => void;
  isAdmin: boolean;
  onApprove: (approved: boolean) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const electronic = line.method === 'PAYPAL' || line.method === 'VENMO';

  return (
    <div className="bg-surface-50 border border-gray-700 rounded-lg">
      <div className="flex items-center gap-3 p-3">
        <button
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`Show what ${line.sellerName} sold`}
          className="text-gray-500 hover:text-white w-5 shrink-0"
        >
          <FontAwesomeIcon icon={open ? faChevronDown : faChevronRight} className="h-3.5 w-3.5" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="text-white text-sm truncate">{line.sellerName}</p>
          <p className="text-gray-500 text-xs truncate">
            {line.method === 'CHECK' ? 'Check'
              : line.method === 'DONATE' ? 'Donated to the patrol'
              : `${line.method === 'VENMO' ? 'Venmo' : 'PayPal'} · ${line.destination ?? 'no destination'}`}
            {' · '}
            {line.items.length} {line.items.length === 1 ? 'item' : 'items'}
          </p>
          {line.statusNote && (
            <p className="text-amber-400/80 text-xs mt-0.5">{line.statusNote}</p>
          )}
        </div>

        <div className="text-right shrink-0">
          <p className="text-white text-sm font-medium">{usd(line.netCents)}</p>
          {line.commissionCents > 0 && (
            <p className="text-gray-500 text-xs">of {usd(line.grossCents)}</p>
          )}
        </div>

        <span className={`text-xs px-2 py-0.5 rounded border shrink-0 ${STATUS_TONE[line.status]}`}>
          {STATUS_LABEL[line.status]}
        </span>

        {isAdmin && electronic && (
          <div className="shrink-0 w-28 text-right">
            {line.status === 'PENDING' && (
              <button
                onClick={() => onApprove(true)}
                disabled={busy || !line.destination}
                title={line.destination ? undefined : 'This seller has no usable destination'}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white text-xs px-3 py-1.5 rounded"
              >
                Approve
              </button>
            )}
            {line.status === 'APPROVED' && (
              <button
                onClick={() => onApprove(false)}
                disabled={busy}
                className="text-gray-400 hover:text-white text-xs px-2 py-1.5"
              >
                Undo
              </button>
            )}
            {line.status === 'UNCLAIMED' && (
              <button
                onClick={() => {
                  if (confirm('Take this payout back from PayPal? The money returns now and the line goes back for review.')) onCancel();
                }}
                disabled={busy}
                className="text-amber-400 hover:text-amber-300 text-xs px-2 py-1.5"
              >
                Take back
              </button>
            )}
          </div>
        )}
      </div>

      {/* The evidence. Listed price times what sold, next to what the register
          actually took — a seller asking "why that number" is answered here
          rather than by somebody going to Square. */}
      {open && (
        <div className="border-t border-gray-800 px-4 py-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 text-left">
                <th className="pb-1.5 font-normal">Item</th>
                <th className="pb-1.5 font-normal">SKU</th>
                <th className="pb-1.5 font-normal text-right">Listed</th>
                <th className="pb-1.5 font-normal text-right">Qty</th>
                <th className="pb-1.5 font-normal text-right">Collected</th>
                <th className="pb-1.5 font-normal text-right">Sold</th>
              </tr>
            </thead>
            <tbody>
              {line.items.map((item) => {
                const listed = item.priceCents * item.quantity;
                const discounted = item.collectedCents < listed;
                return (
                  <tr key={item.id} className="border-t border-gray-800/60">
                    <td className="py-1.5 text-gray-200">{item.name}</td>
                    <td className="py-1.5 text-gray-500 font-mono">{item.sku}</td>
                    <td className="py-1.5 text-gray-300 text-right">{usd(listed)}</td>
                    <td className="py-1.5 text-gray-400 text-right">
                      {item.quantity}
                      {item.refundedQty > 0 && (
                        <span className="text-amber-400"> (−{item.refundedQty})</span>
                      )}
                    </td>
                    <td className={`py-1.5 text-right ${discounted ? 'text-amber-400' : 'text-gray-400'}`}>
                      {usd(item.collectedCents)}
                    </td>
                    <td className="py-1.5 text-gray-500 text-right">
                      {new Date(item.soldAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Checks ──────────────────────────────────────────────────────────────────

function ChecksTab({
  run, isAdmin, onChanged,
}: { run: PayoutRun; isAdmin: boolean; onChanged: () => void }) {
  const { orgId } = useOutletContext<SkiSwapContext>();
  const { data: payees, isLoading } = useQuery({
    queryKey: ['ski-swap/payout-checks', orgId, run.id],
    queryFn: () => api.skiSwap.listCheckPayees(orgId, run.id),
    enabled: !!orgId,
  });

  const record = useMutation({
    // `sentAt` left out means "leave the date alone" — saving a check number
    // must not also mark the check as posted.
    mutationFn: (v: { lineId: string; checkNumber?: string | null; sentAt?: string | null }) =>
      api.skiSwap.recordCheckSent(orgId, run.id, v.lineId, {
        ...(v.checkNumber !== undefined ? { checkNumber: v.checkNumber } : {}),
        ...(v.sentAt !== undefined ? { sentAt: v.sentAt } : {}),
      }),
    onSuccess: onChanged,
  });

  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function downloadCsv() {
    setDownloadError(null);
    try {
      const blob = await api.skiSwap.checksCsv(orgId, run.id);
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = `checks-${run.swapTitle.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoking immediately can cancel the save in some browsers.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Could not build the check register');
    }
  }

  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  if (!payees?.length) {
    return <p className="text-gray-500 text-sm py-6">Nobody on this run is being paid by check.</p>;
  }

  const total = payees.reduce((sum, p) => sum + p.amountCents, 0);
  const missingAddress = payees.filter((p) => !p.street || !p.city || !p.zip);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-400">
          {payees.length} {payees.length === 1 ? 'check' : 'checks'}, {usd(total)} in total.
        </p>
        <button
          onClick={downloadCsv}
          className="bg-surface-100 hover:bg-surface-200 text-white text-sm px-3 py-1.5 rounded"
        >
          <FontAwesomeIcon icon={faFileArrowDown} className="mr-1.5 h-3.5 w-3.5" />
          Download CSV
        </button>
      </div>

      {missingAddress.length > 0 && (
        <div className="flex items-start gap-3 bg-yellow-900/30 border border-yellow-700 rounded-lg p-3">
          <span className="text-yellow-400 leading-none">⚠</span>
          <p className="text-yellow-200 text-sm">
            {missingAddress.length}{' '}
            {missingAddress.length === 1 ? 'payee has' : 'payees have'} no complete address. Their
            check cannot be posted until somebody fills it in.
          </p>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-left border-b border-gray-800">
              <th className="pb-2 font-normal">Name</th>
              <th className="pb-2 font-normal">Address</th>
              <th className="pb-2 font-normal">Phone</th>
              <th className="pb-2 font-normal text-right">Amount</th>
              <th className="pb-2 font-normal">Check #</th>
              <th className="pb-2 font-normal">Sent</th>
            </tr>
          </thead>
          <tbody>
            {payees.map((p) => (
              <CheckRow
                key={p.reference}
                payee={p}
                isAdmin={isAdmin && run.status !== 'CLOSED'}
                busy={record.isPending}
                onSave={(checkNumber, sentAt) =>
                  record.mutate({ lineId: p.reference, checkNumber, sentAt })
                }
              />
            ))}
          </tbody>
        </table>
      </div>

      {record.isError && (
        <p className="text-sm text-red-400">
          {record.error instanceof ApiError ? record.error.message : 'Could not save that'}
        </p>
      )}
      {downloadError && <p className="text-sm text-red-400">{downloadError}</p>}
    </div>
  );
}

function CheckRow({
  payee, isAdmin, busy, onSave,
}: {
  payee: import('../../lib/api.types').CheckPayee;
  isAdmin: boolean;
  busy: boolean;
  /** `sentAt` omitted leaves the posted date where it is. */
  onSave: (checkNumber: string | null, sentAt?: string | null) => void;
}) {
  const [number, setNumber] = useState(payee.checkNumber ?? '');
  const address = [payee.street, payee.city, payee.state, payee.zip].filter(Boolean).join(', ');

  return (
    <tr className="border-b border-gray-800/60">
      <td className="py-2 text-gray-200">{payee.sellerName}</td>
      <td className="py-2 text-gray-400">
        {address || <span className="text-amber-400">No address on file</span>}
      </td>
      <td className="py-2 text-gray-400">{payee.phone ?? '—'}</td>
      <td className="py-2 text-white text-right font-medium">{usd(payee.amountCents)}</td>
      <td className="py-2">
        {isAdmin ? (
          <input
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onBlur={() => {
              if (number !== (payee.checkNumber ?? '')) onSave(number || null);
            }}
            placeholder="—"
            aria-label={`Check number for ${payee.sellerName}`}
            className="w-20 bg-surface-100 border border-gray-700 rounded px-2 py-1 text-xs text-white"
          />
        ) : (
          <span className="text-gray-400">{payee.checkNumber ?? '—'}</span>
        )}
      </td>
      <td className="py-2">
        {payee.sentAt ? (
          <span className="text-green-400 text-xs">
            {new Date(payee.sentAt).toLocaleDateString()}
            {isAdmin && (
              <button
                onClick={() => onSave(number || null, null)}
                disabled={busy}
                className="ml-2 text-gray-500 hover:text-white"
              >
                undo
              </button>
            )}
          </span>
        ) : isAdmin ? (
          <button
            onClick={() => onSave(number || null, new Date().toISOString())}
            disabled={busy}
            className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-white text-xs px-2.5 py-1 rounded"
          >
            Mark sent
          </button>
        ) : (
          <span className="text-gray-500 text-xs">Not sent</span>
        )}
      </td>
    </tr>
  );
}

// ─── Discounts ───────────────────────────────────────────────────────────────

/**
 * Where the register took less than the item listed at (§5).
 *
 * A discount is the org's to give, so the seller is still paid the listed
 * price — which means the difference comes out of the patrol's pocket and is
 * worth being able to see.
 */
function DiscountsTab({ orgId, runId }: { orgId: string; runId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['ski-swap/payout-discounts', orgId, runId],
    queryFn: () => api.skiSwap.getPayoutDiscounts(orgId, runId),
    enabled: !!orgId,
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  if (!data?.discounts.length) {
    return (
      <p className="text-gray-500 text-sm py-6">
        Every item sold for its listed price. Nothing was discounted.
      </p>
    );
  }

  const zeroes = data.discounts.filter((d) => d.zeroCollected);

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        {data.discounts.length} {data.discounts.length === 1 ? 'item' : 'items'} sold below the
        listed price, costing the patrol{' '}
        <span className="text-white">{data.totalGapFormatted}</span>. Sellers were paid the listed
        price regardless.
      </p>

      {zeroes.length > 0 && (
        <p className="text-xs text-amber-300/90 bg-amber-500/5 border border-amber-800/50 rounded px-3 py-2">
          {zeroes.length} of these collected nothing at all. That is as likely to be a mis-scanned
          item as a give-away, so they are listed but not counted in the total.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-left border-b border-gray-800">
              <th className="pb-2 font-normal">Item</th>
              <th className="pb-2 font-normal">SKU</th>
              <th className="pb-2 font-normal">Seller</th>
              <th className="pb-2 font-normal text-right">Listed</th>
              <th className="pb-2 font-normal text-right">Collected</th>
              <th className="pb-2 font-normal text-right">Difference</th>
            </tr>
          </thead>
          <tbody>
            {data.discounts.map((d, i) => (
              <tr key={`${d.itemId ?? d.sku}-${i}`} className="border-b border-gray-800/60">
                <td className="py-2 text-gray-200">{d.name}</td>
                <td className="py-2 text-gray-500 font-mono text-xs">{d.sku}</td>
                <td className="py-2 text-gray-400">{d.sellerName}</td>
                <td className="py-2 text-gray-300 text-right">{usd(d.listedCents)}</td>
                <td className="py-2 text-right text-gray-400">
                  {usd(d.collectedCents)}
                  {d.zeroCollected && <span className="text-amber-400 ml-1.5">?</span>}
                </td>
                <td className="py-2 text-amber-400 text-right">−{usd(d.gapCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
