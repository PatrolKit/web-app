import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import SearchableSelect from '../../components/SearchableSelect';
import type {
  DiagnosticChoice, DiagnosticIssueResponse, DiagnosticRunResponse, SellerResponse, SwapResponse,
} from '../../lib/api.types';
import {
  CHOICE_LABEL, decidedText, groupChoiceLabel, groupsOf, isOpen, rowChoices, shown, squareCopies, squareSide, tookText,
  type DiagnosticGroup,
} from './swapDiagnosticsView';

const latestKey = (orgId: string, swapId: string) => ['ski-swap/diagnostics', orgId, swapId];
const PAGE = 100;

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

/**
 * Swap diagnostics (Plan 41): our items against the swap's Square category,
 * matched by SKU. Every disagreement is a row with its own choices; nothing
 * changes until someone clicks one.
 */
export default function SwapDiagnosticsModal({ orgId, swap, onClose }: {
  orgId: string;
  swap: SwapResponse;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const key = latestKey(orgId, swap.id);
  const { data: run, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.skiSwap.latestDiagnostics(orgId, swap.id),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () => api.skiSwap.startDiagnostics(orgId, swap.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const { data: sellers = [] } = useQuery<SellerResponse[]>({
    queryKey: ['ski-swap/sellers', orgId],
    queryFn: () => api.skiSwap.listSellers(orgId),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const running = run?.status === 'running' || start.isPending;
  const groups = useMemo(() => (run && run.status === 'done' ? groupsOf(run) : []), [run]);
  const openCount = groups.reduce((n, g) => n + g.open, 0);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center z-50 p-4 pt-[5vh]" onClick={onClose}>
      <div
        role="dialog" aria-modal="true" aria-label="Diagnostics"
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 pb-4 space-y-3 border-b border-gray-800 shrink-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-white font-medium">Diagnostics: {swap.title}</h3>
              <p className="text-sm text-gray-400 mt-0.5">
                Compares this swap’s items in PatrolKit with its items in Square, by SKU. Nothing changes until you choose.
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-gray-400 hover:text-white text-lg leading-none">×</button>
          </div>
          {/* The run and the way to run it, together: what was found, and when. */}
          <div className="flex items-center justify-between gap-4 bg-surface-100 rounded-lg px-3 py-2">
            <RunLine run={run ?? null} loading={isLoading} />
            <button
              type="button"
              onClick={() => start.mutate()}
              disabled={running}
              className="shrink-0 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-3 py-1.5 rounded text-sm font-medium"
            >
              {running ? 'Checking…' : run ? 'Run checks again' : 'Run checks'}
            </button>
          </div>
        </div>

        <div className="overflow-y-auto p-5 space-y-5">
          {error && <p className="text-sm text-red-400">{errorText(error)}</p>}
          {start.error && <p className="text-sm text-red-400">{errorText(start.error)}</p>}
          {run?.status === 'running' && (
            <p className="text-sm text-gray-300">Reading Square: {run.done.toLocaleString('en-US')} items so far…</p>
          )}
          {run?.status === 'failed' && <p className="text-sm text-red-400">The check failed: {run.error}</p>}
          {run?.status === 'done' && openCount === 0 && (
            <p className="text-sm text-green-400">
              ✓ Everything matches{run.issues.length ? ': every issue from this run has been dealt with.' : '.'}
            </p>
          )}
          {run?.status === 'done' && groups.map((g) => (
            <Group key={g.key} group={g} run={run} orgId={orgId} swapId={swap.id} sellers={sellers} onChanged={refresh} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** "Last run 9:42 PM by Dana · took 48 s · 9,812 in PatrolKit · 9,809 in Square". */
function RunLine({ run, loading }: { run: DiagnosticRunResponse | null; loading: boolean }) {
  if (loading) return <p className="text-xs text-gray-400">Loading…</p>;
  if (!run) return <p className="text-xs text-gray-400">Not run yet.</p>;
  if (run.status === 'interrupted') return <p className="text-xs text-amber-400">The last check was interrupted. Run it again.</p>;
  const when = new Date(run.startedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const parts = [
    `Last run ${when}${run.startedByName ? ` by ${run.startedByName}` : ''}`,
    tookText(run),
    run.ourCount !== null ? `${run.ourCount.toLocaleString('en-US')} in PatrolKit` : null,
    run.squareCount !== null ? `${run.squareCount.toLocaleString('en-US')} in Square` : null,
  ].filter(Boolean);
  return <p className="text-xs text-gray-400">{parts.join(' · ')}</p>;
}

function sellerOptions(sellers: SellerResponse[]) {
  return sellers.map((s) => ({ value: s.id, label: s.displayName, sublabel: s.phone ?? undefined, keywords: s.email ?? undefined }));
}

/** One kind of issue: what it means, its group choices (D4), and its rows. */
function Group({ group, run, orgId, swapId, sellers, onChanged }: {
  group: DiagnosticGroup;
  run: DiagnosticRunResponse;
  orgId: string;
  swapId: string;
  sellers: SellerResponse[];
  onChanged: () => void;
}) {
  const [shownRows, setShownRows] = useState(PAGE);
  const [groupSeller, setGroupSeller] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const all = useMutation({
    mutationFn: (choice: DiagnosticChoice) => api.skiSwap.applyDiagnosticChoiceToAll(orgId, swapId, run.id, {
      kind: group.kind, ...(group.field ? { field: group.field } : {}), choice,
      ...(choice === 'copy_to_patrolkit' && groupSeller ? { sellerId: groupSeller } : {}),
    }),
    onSuccess: (r) => {
      setResult([
        `${r.applied.toLocaleString('en-US')} done`,
        r.skipped ? `${r.skipped} changed since the check ran (run it again to see them)` : null,
        r.failed ? `${r.failed} failed (see the rows)` : null,
      ].filter(Boolean).join(', '));
      onChanged();
    },
  });

  function applyAll(choice: DiagnosticChoice) {
    const n = group.open;
    const what = choice === 'resolve'
      ? `Mark all ${n} resolved? Nothing changes in Square or PatrolKit; any that still disagree won’t come up again until something changes.`
      : `${groupChoiceLabel(choice, n)}? This changes ${n === 1 ? 'that item' : `all ${n} items`}${choice === 'copy_to_patrolkit' ? ' (deleted items with the same SKU are restored instead)' : ''}.`;
    if (window.confirm(what)) all.mutate(choice);
  }

  return (
    <section className="border border-gray-800 rounded-lg">
      <div className="p-3 space-y-2 border-b border-gray-800">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-white text-sm font-medium">
            {group.title}{' '}
            <span className={group.open ? 'text-red-400' : 'text-gray-500'}>
              ({group.open ? `${group.open.toLocaleString('en-US')} open` : 'all dealt with'})
            </span>
          </h4>
        </div>
        <p className="text-xs text-gray-400">{group.explain}</p>
        {group.open > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            {group.groupChoices.includes('copy_to_patrolkit') && (
              <div className="w-64">
                <SearchableSelect value={groupSeller} onChange={setGroupSeller} options={sellerOptions(sellers)}
                  placeholder="Seller for all of them…" clearLabel="No seller chosen" />
              </div>
            )}
            {group.groupChoices.map((c) => (
              <button key={c} type="button" onClick={() => applyAll(c)}
                disabled={all.isPending || (c === 'copy_to_patrolkit' && !groupSeller)}
                className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-2.5 py-1 rounded text-xs">
                {groupChoiceLabel(c, group.open)}
              </button>
            ))}
          </div>
        )}
        {all.isPending && <p className="text-xs text-gray-400">Working…</p>}
        {result && <p className="text-xs text-gray-300">{result}</p>}
        {all.error && <p className="text-xs text-red-400">{errorText(all.error)}</p>}
      </div>
      <ul className="divide-y divide-gray-800">
        {group.issues.slice(0, shownRows).map((i) => (
          <IssueRow key={i.id} issue={i} orgId={orgId} swapId={swapId} sellers={sellers} onChanged={onChanged} />
        ))}
      </ul>
      {group.issues.length > shownRows && (
        <button type="button" onClick={() => setShownRows((n) => n + PAGE)}
          className="w-full text-xs text-brand-500 hover:underline py-2 border-t border-gray-800">
          Show {Math.min(PAGE, group.issues.length - shownRows)} more of {(group.issues.length - shownRows).toLocaleString('en-US')}
        </button>
      )}
    </section>
  );
}

/** One issue: the SKU, both sides, and its choices; or what was chosen. */
function IssueRow({ issue, orgId, swapId, sellers, onChanged }: {
  issue: DiagnosticIssueResponse;
  orgId: string;
  swapId: string;
  sellers: SellerResponse[];
  onChanged: () => void;
}) {
  const [seller, setSeller] = useState('');
  const apply = useMutation({
    mutationFn: (body: { choice: DiagnosticChoice; sellerId?: string; restoreItemId?: string; keepSquareItemId?: string }) =>
      api.skiSwap.applyDiagnosticChoice(orgId, swapId, issue.id, body),
    onSuccess: onChanged,
  });
  const open = isOpen(issue);
  const sq = squareSide(issue);
  const ours = issue.ours && !issue.ours.deleted ? issue.ours : null;
  const deleted = issue.ours?.deleted ? issue.ours : null;
  const compareField = issue.kind === 'differs' ? issue.field : null;

  return (
    <li className={`p-3 text-sm space-y-2 ${open ? '' : 'opacity-50'}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/dashboard/ski-swap/items?q=${encodeURIComponent(issue.sku)}`} target="_blank"
          className="font-mono text-brand-400 hover:underline">{issue.sku}</Link>
        <span className="text-gray-200">{ours?.name ?? sq?.name ?? squareCopies(issue)[0]?.name ?? ''}</span>
        {ours?.sellerName && <span className="text-xs text-gray-500">{ours.sellerName}</span>}
      </div>

      {issue.kind === 'differs' && (
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div><span className="text-gray-500">Ours: </span><span className="text-gray-200">{shown(compareField, ours)}</span></div>
          <div><span className="text-gray-500">Square’s: </span><span className="text-gray-200">{shown(compareField, sq)}</span></div>
        </div>
      )}
      {issue.kind === 'not_linked' && (
        <p className="text-xs text-gray-400">
          Ours points at {ours?.squareItemId ? <span className="font-mono">{ours.squareItemId}</span> : 'nothing'}; Square’s item is{' '}
          <span className="font-mono">{sq?.itemId}</span>.
        </p>
      )}
      {issue.kind === 'only_square' && (
        <p className="text-xs text-gray-400">
          Square: {sq?.name}, {shown('price', sq)}.
          {deleted && <> One of our deleted items had this SKU ({deleted.name}{deleted.sellerName ? `, ${deleted.sellerName}` : ''}).</>}
        </p>
      )}
      {issue.kind === 'only_ours' && ours && (
        <p className="text-xs text-gray-400">Ours: {shown('price', ours)}.</p>
      )}

      {!open && <p className="text-xs text-gray-400">{decidedText(issue)}</p>}
      {issue.state === 'failed' && issue.error && <p className="text-xs text-red-400">{issue.error}</p>}
      {apply.error && <p className="text-xs text-red-400">{errorText(apply.error)}</p>}

      {open && issue.kind === 'twice' && (
        <ul className="space-y-1">
          {squareCopies(issue).map((c) => (
            <li key={c.itemId} className="flex items-center justify-between gap-3 text-xs bg-surface-100 rounded px-2 py-1.5">
              <span className="text-gray-300">
                {c.name} · {shown('price', c)}
                <span className="text-gray-500"> · Square item <span className="font-mono">{c.itemId}</span></span>
                {c.updatedAt && <span className="text-gray-500"> · changed {new Date(c.updatedAt).toLocaleDateString('en-US')}</span>}
              </span>
              <button type="button" disabled={apply.isPending}
                onClick={() => { if (window.confirm('Keep this copy, and delete the others from Square?')) apply.mutate({ choice: 'keep', keepSquareItemId: c.itemId }); }}
                className="text-brand-500 hover:underline disabled:opacity-40">{CHOICE_LABEL.keep}</button>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="flex flex-wrap items-center gap-2">
          {issue.kind === 'only_square' && (
            <>
              {deleted && (
                <button type="button" disabled={apply.isPending}
                  onClick={() => apply.mutate({ choice: 'copy_to_patrolkit', restoreItemId: deleted.itemId })}
                  className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-2.5 py-1 rounded text-xs">
                  Restore the deleted item
                </button>
              )}
              <div className="w-56">
                <SearchableSelect value={seller} onChange={setSeller} options={sellerOptions(sellers)}
                  placeholder="Seller…" clearLabel="No seller chosen" />
              </div>
            </>
          )}
          {rowChoices(issue).map((c) => (
            <button key={c} type="button"
              disabled={apply.isPending || (c === 'copy_to_patrolkit' && !seller)}
              onClick={() => apply.mutate({ choice: c, ...(c === 'copy_to_patrolkit' ? { sellerId: seller } : {}) })}
              className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-2.5 py-1 rounded text-xs">
              {c === 'copy_to_patrolkit' && deleted ? 'Copy to PatrolKit as new' : CHOICE_LABEL[c]}
            </button>
          ))}
          {apply.isPending && <span className="text-xs text-gray-400">Working…</span>}
        </div>
      )}
    </li>
  );
}
