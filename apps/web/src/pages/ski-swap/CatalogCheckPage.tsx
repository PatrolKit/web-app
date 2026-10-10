import { useMemo, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import SearchableSelect from '../../components/SearchableSelect';
import type {
  DiagnosticChoice, DiagnosticIssueResponse, DiagnosticRunResponse, SellerResponse,
} from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import { BusyBanner, FoldHeader, SidePanel, Tombstone, useFolds, useJustDecided } from './ReportCard';
import {
  CHOICE_LABEL, canUseSquarePrice, centsOf, decidedText, groupChoiceLabel, groupsOf, heldText, isHeld, isOpen, priceDecidedText, priceSides,
  rowChoices, shown, squareCopies, squareSide, stockText, tookText,
  type DiagnosticGroup,
} from './swapDiagnosticsView';

const latestKey = (orgId: string, swapId: string) => ['ski-swap/diagnostics', orgId, swapId];
/** Price differs' "Set different price…": bordered too, quieter than the two above. */
const bordered = 'border border-gray-600 text-gray-200 hover:bg-surface-200 hover:border-gray-500 disabled:opacity-40 px-3 py-1.5 rounded text-xs font-medium';
/** Price differs' "Use this price": outlined, so it reads as a button on the card. */
const outlined = 'border border-brand-500/70 text-brand-300 hover:bg-brand-600 hover:border-brand-600 hover:text-white disabled:opacity-40 disabled:hover:bg-transparent px-3 py-1.5 rounded text-xs font-medium';
const PAGE = 100;

function errorText(err: unknown): string {
  return err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
}

/**
 * Catalog check (Plan 48 D2): Plan 41's swap diagnostics as a page in Reports,
 * for the selected swap. Our items against Square, by SKU, and (D11) any other
 * Square item a scan of one of our tickets could find. Running the checks
 * reads Square and records what it found; nothing changes until someone picks
 * a choice.
 */
export default function CatalogCheckPage() {
  const { orgId, perms, selectedSwap: swap } = useOutletContext<SkiSwapContext>();
  if (!swap) return <p className="text-sm text-gray-400">Pick a swap to check.</p>;
  // The checks and their choices change Square, so they're an admin's (Plan 41 D12).
  if (!perms.has('ski_swap:admin')) return <p className="text-sm text-gray-400">Catalog check is for administrators.</p>;
  return <CatalogCheck orgId={orgId} swapId={swap.id} title={swap.title} />;
}

function CatalogCheck({ orgId, swapId, title }: { orgId: string; swapId: string; title: string }) {
  const qc = useQueryClient();
  const key = latestKey(orgId, swapId);
  const { data: run, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api.skiSwap.latestDiagnostics(orgId, swapId),
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
  const start = useMutation({
    mutationFn: () => api.skiSwap.startDiagnostics(orgId, swapId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const { data: sellers = [] } = useQuery<SellerResponse[]>({
    queryKey: ['ski-swap/sellers', orgId],
    queryFn: () => api.skiSwap.listSellers(orgId),
  });

  const running = run?.status === 'running' || start.isPending;
  const folds = useFolds('patrolkit:catalog-check:collapsed');
  const groups = useMemo(() => (run && run.status === 'done' ? groupsOf(run) : []), [run]);
  const openCount = groups.reduce((n, g) => n + g.open, 0);
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  /**
   * One issue decided: shown at once from the answer, before the page reads
   * again (that read waits on Square's sales, for what they hold back).
   */
  const decided = (updated: DiagnosticIssueResponse) => {
    qc.setQueryData<DiagnosticRunResponse | null>(key, (r) => r && {
      ...r, issues: r.issues.map((i) => (i.id === updated.id ? { ...i, ...updated, heldBySales: i.heldBySales, squareUrl: i.squareUrl } : i)),
    });
    refresh();
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <p className="text-sm text-gray-400">
          Compares {title}’s items in PatrolKit with Square, by SKU, and looks for any other Square item one of its tickets
          would scan as. Nothing changes until you choose.
        </p>
        {/* The run and the way to run it, together: what was found, and when. */}
        <div className="flex items-center justify-between gap-4 bg-surface-50 border border-gray-800 rounded-lg px-3 py-2">
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

      {error && <p className="text-sm text-red-400">{errorText(error)}</p>}
      {start.error && <p className="text-sm text-red-400">{errorText(start.error)}</p>}
      {run?.status === 'running' && (
        <p className="text-sm text-gray-300">Reading Square: {run.done.toLocaleString('en-US')} items so far…</p>
      )}
      {run?.status === 'failed' && <p className="text-sm text-red-400">The check failed: {run.error}</p>}
      {run?.status === 'done' && run.salesCheckError && (
        <p className="text-sm text-amber-400">
          Couldn’t read Square’s sales, so it isn’t known which tickets have an open sale in Sales check. Choices are refused until it can be read: {run.salesCheckError}
        </p>
      )}
      {run?.status === 'done' && openCount === 0 && (
        <p className="text-sm text-green-400">
          ✓ Everything matches{run.issues.length ? ': every issue from this run has been dealt with.' : '.'}
        </p>
      )}
      {run?.status === 'done' && groups.length > 1 && (
        <p className="text-xs">
          <button type="button" className="text-brand-500 hover:underline" onClick={() => folds.toggleAll(groups.map((g) => g.key))}>
            {folds.allFolded(groups.map((g) => g.key)) ? 'Expand all' : 'Collapse all'}
          </button>
        </p>
      )}
      {run?.status === 'done' && groups.map((g) => (
        <Group key={g.key} group={g} run={run} orgId={orgId} swapId={swapId} sellers={sellers} onChanged={refresh} onDecided={decided}
          folded={folds.isFolded(g.key)} onToggle={() => folds.toggle(g.key)} />
      ))}
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
function Group({ group, run, orgId, swapId, sellers, onChanged, onDecided, folded, onToggle }: {
  group: DiagnosticGroup;
  run: DiagnosticRunResponse;
  orgId: string;
  swapId: string;
  sellers: SellerResponse[];
  onChanged: () => void;
  onDecided: (updated: DiagnosticIssueResponse) => void;
  folded: boolean;
  onToggle: () => void;
}) {
  const priceCards = group.kind === 'differs' && group.field === 'price';
  const [shownRows, setShownRows] = useState(PAGE);
  const [groupSeller, setGroupSeller] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const all = useMutation({
    mutationFn: ({ choice }: { choice: DiagnosticChoice }) => api.skiSwap.applyDiagnosticChoiceToAll(orgId, swapId, run.id, {
      kind: group.kind, ...(group.field ? { field: group.field } : {}), choice,
      ...(choice === 'copy_to_patrolkit' && groupSeller ? { sellerId: groupSeller } : {}),
    }),
    onSuccess: (r) => {
      setResult([
        `${r.applied.toLocaleString('en-US')} done`,
        r.held ? `${r.held} left for their open sales in Sales check` : null,
        r.skipped ? `${r.skipped} changed since the check ran (run it again to see them)` : null,
        r.failed ? `${r.failed} failed (see the rows)` : null,
      ].filter(Boolean).join(', '));
      onChanged();
    },
  });

  /** What a group choice changes: open rows not held for Sales check. */
  const fixable = group.open - group.held;

  function applyAll(choice: DiagnosticChoice) {
    const n = fixable;
    const what = choice === 'resolve'
      ? `Mark all ${n} resolved? Nothing changes in Square or PatrolKit; any that still disagree won’t come up again until something changes.`
      : `${groupChoiceLabel(choice, n)}? This changes ${n === 1 ? 'that item' : `all ${n} items`}${choice === 'copy_to_patrolkit' ? ' (deleted items with the same SKU are restored instead)' : ''}.`;
    if (window.confirm(what)) all.mutate({ choice });
  }

  return (
    <section className="border border-gray-800 rounded-lg">
      <div className={`p-3 space-y-2 ${folded ? '' : 'border-b border-gray-800'}`}>
        <FoldHeader folded={folded} onToggle={onToggle}>
          <h4 className="text-white text-sm font-medium">
            {group.title}{' '}
            <span className={group.open ? 'text-red-400' : 'text-gray-500'}>
              ({group.open ? `${group.open.toLocaleString('en-US')} open` : 'all dealt with'})
            </span>
            {group.held > 0 && <span className="text-amber-400 text-xs font-normal"> · {group.held} waiting on Sales check</span>}
          </h4>
        </FoldHeader>
        {!folded && (<>
        <p className="text-xs text-gray-400 ml-5">{group.explain}</p>
        {group.held > 0 && (
          <p className="text-xs text-amber-400">
            {group.held === 1 ? 'One has' : `${group.held} have`} an open sale in Sales check, so {group.held === 1 ? 'it’s' : 'they’re'} left out of the choices below.{' '}
            <Link to="/dashboard/ski-swap/reports" className="underline hover:text-amber-300">Open Sales check</Link>
          </p>
        )}
        {fixable > 1 && (
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
                {groupChoiceLabel(c, fixable)}
              </button>
            ))}
          </div>
        )}
        {all.isPending && all.variables && (
          <BusyBanner what={`${groupChoiceLabel(all.variables.choice, fixable)}: ${fixable === 1 ? 'one item' : `${fixable.toLocaleString('en-US')} items`}, each checked against Square first…`} />
        )}
        {result && <p className="text-xs text-gray-300">{result}</p>}
        {all.error && <p className="text-xs text-red-400">{errorText(all.error)}</p>}
        </>)}
      </div>
      {!folded && (<>
      {priceCards ? (
        <div className="p-3 space-y-3">
          {group.issues.slice(0, shownRows).map((i) => <PriceCard key={i.id} issue={i} orgId={orgId} swapId={swapId} onDecided={onDecided} />)}
        </div>
      ) : (
        <div className="p-3 space-y-3">
          {group.issues.slice(0, shownRows).map((i) => (
            <IssueRow key={i.id} issue={i} orgId={orgId} swapId={swapId} sellers={sellers} onDecided={onDecided} />
          ))}
        </div>
      )}
      {group.issues.length > shownRows && (
        <button type="button" onClick={() => setShownRows((n) => n + PAGE)}
          className="w-full text-xs text-brand-500 hover:underline py-2 border-t border-gray-800">
          Show {Math.min(PAGE, group.issues.length - shownRows)} more of {(group.issues.length - shownRows).toLocaleString('en-US')}
        </button>
      )}
      </>)}
    </section>
  );
}

/**
 * Price differs as a card, laid out as Sales check's: Square's item and ours
 * side by side, each with "Use this price", and a different price for both below.
 */
function PriceCard({ issue, orgId, swapId, onDecided }: {
  issue: DiagnosticIssueResponse; orgId: string; swapId: string; onDecided: (updated: DiagnosticIssueResponse) => void;
}) {
  /** Decided here: settles in, and a new price is remembered for the tombstone. */
  const [done, setDone] = useState<{ cents?: number } | null>(null);
  const justDecided = useJustDecided(isOpen(issue));
  const apply = useMutation({
    mutationFn: (body: { choice: DiagnosticChoice; priceCents?: number }) => api.skiSwap.applyDiagnosticChoice(orgId, swapId, issue.id, body),
    onSuccess: (updated, body) => {
      if (updated.state !== 'failed') setDone({ cents: body.priceCents });
      onDecided(updated);
    },
  });
  const held = isHeld(issue);
  const sides = priceSides(issue);
  const busy = apply.isPending;

  if (!isOpen(issue)) return <Tombstone text={`${issue.sku}: ${priceDecidedText(issue, done?.cents)}`} hint="" settle={!!done || justDecided} />;

  /** Asks for the price, again until it's one, or until cancelled. */
  function setDifferent() {
    let ask = `A different price for ${issue.sku}, in both PatrolKit and Square:`;
    for (;;) {
      const typed = window.prompt(ask, '');
      if (typed === null) return;
      const cents = centsOf(typed);
      if (cents !== null) { apply.mutate({ choice: 'set_price', priceCents: cents }); return; }
      ask = `“${typed}” isn’t a price. Enter one above $0, like 40 or 40.50:`;
    }
  }

  const use = (choice: 'use_square' | 'use_ours', enabled = true) => (held ? undefined : (
    <button type="button" className={outlined} disabled={busy || !enabled} onClick={() => apply.mutate({ choice })}>Use this price</button>
  ));

  return (
    <div className={`border border-gray-800 rounded-lg overflow-hidden bg-surface-50 transition-opacity ${busy ? 'opacity-60' : ''}`} aria-busy={busy}>
      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_1.75rem_minmax(0,1fr)]">
        <SidePanel side={sides.square} icon="■" action={use('use_square', canUseSquarePrice(issue))} />
        <div className="hidden md:flex items-center justify-center text-gray-600">≠</div>
        <SidePanel side={sides.ours} icon="◆" className="border-t md:border-t-0 md:border-l border-gray-800" action={use('use_ours')} />
      </div>
      {held ? (
        <p className="px-3 py-2 border-t border-gray-800 text-xs text-amber-300 bg-amber-900/20">
          ⏸ {heldText(issue)}{' '}
          <Link to="/dashboard/ski-swap/reports" className="underline hover:text-amber-200">Open Sales check</Link>
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-gray-800 bg-surface-100/40">
          {issue.state === 'failed' && issue.error && <span className="text-xs text-red-400">{issue.error}</span>}
          {apply.error && <span className="text-xs text-red-400">{errorText(apply.error)}</span>}
          {busy && <span className="text-xs text-gray-400">Working…</span>}
          <button type="button" className={`${bordered} ml-auto`} disabled={busy} onClick={setDifferent}>Set different price…</button>
        </div>
      )}
    </div>
  );
}

/** One issue: the SKU, both sides, and its choices; or what was chosen. */
function IssueRow({ issue, orgId, swapId, sellers, onDecided }: {
  issue: DiagnosticIssueResponse;
  orgId: string;
  swapId: string;
  sellers: SellerResponse[];
  onDecided: (updated: DiagnosticIssueResponse) => void;
}) {
  const [seller, setSeller] = useState('');
  const apply = useMutation({
    mutationFn: (body: { choice: DiagnosticChoice; sellerId?: string; restoreItemId?: string; keepSquareItemId?: string; prefix?: string }) =>
      api.skiSwap.applyDiagnosticChoice(orgId, swapId, issue.id, body),
    onSuccess: onDecided,
  });
  const held = isHeld(issue);
  // A held row shows what it is, and no choices (Plan 48): its sale comes first.
  const open = isOpen(issue) && !held;
  const justDecided = useJustDecided(isOpen(issue));
  const sq = squareSide(issue);
  const ours = issue.ours && !issue.ours.deleted ? issue.ours : null;
  const deleted = issue.ours?.deleted ? issue.ours : null;
  const compareField = issue.kind === 'differs' ? issue.field : null;
  const name = ours?.name ?? sq?.name ?? squareCopies(issue)[0]?.name ?? '';

  // Dealt with: a green tombstone, as Sales check's, that settles in when it happens on screen.
  if (!isOpen(issue)) return <Tombstone text={`${issue.sku}${name ? ` ${name}` : ''}: ${decidedText(issue)}`} hint="" settle={justDecided} />;

  return (
    <div className="border border-gray-800 rounded-lg bg-surface-50 p-3 text-sm space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/dashboard/ski-swap/items?q=${encodeURIComponent(issue.sku)}`} target="_blank"
          className="font-mono text-brand-400 hover:underline">{issue.sku}</Link>
        <span className="text-gray-200">{name}</span>
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
      {issue.kind === 'only_square' && issue.saleCreditedTo && (
        <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/50 rounded px-2 py-1.5">
          Its sale went on {issue.saleCreditedTo.sku} {issue.saleCreditedTo.name} in Sales check: this is a copy made at the register.
          Copying it to PatrolKit would make a second item for the same thing. Mark it resolved, or delete it in Square.
        </p>
      )}
      {issue.kind === 'stock' && <p className="text-xs text-gray-400">{stockText(issue)}</p>}
      {issue.kind === 'only_ours' && ours && (
        <p className="text-xs text-gray-400">Ours: {shown('price', ours)}.</p>
      )}

      {issue.kind === 'elsewhere' && (
        <ul className="space-y-1">
          {squareCopies(issue).map((c) => (
            <li key={c.itemId} className="text-xs bg-surface-100 rounded px-2 py-1.5 text-gray-300">
              {c.name}
              <span className="text-gray-500"> · SKU <span className="font-mono">{c.sku}</span></span>
              <span className="text-gray-500"> · {c.category ?? 'no category'}</span>
              {c.archived && <span className="text-amber-400"> · archived, still scans</span>}
            </li>
          ))}
        </ul>
      )}

      {held && (
        <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800/50 rounded px-2 py-1.5">
          ⏸ {heldText(issue)}{' '}
          <Link to="/dashboard/ski-swap/reports" className="underline hover:text-amber-200">Open Sales check</Link>
        </p>
      )}
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
          {issue.kind === 'only_square' && !issue.saleCreditedTo && (
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
          {rowChoices(issue).filter((c) => !(c === 'copy_to_patrolkit' && issue.saleCreditedTo)).map((c) => (
            <button key={c} type="button"
              disabled={apply.isPending || (c === 'copy_to_patrolkit' && !seller)}
              onClick={() => {
                if (c === 'delete_other' && !window.confirm(`Delete the other item from Square? This can’t be undone; its past sales stay in Square’s history.`)) return;
                apply.mutate({ choice: c, ...(c === 'copy_to_patrolkit' ? { sellerId: seller } : {}) });
              }}
              className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-2.5 py-1 rounded text-xs">
              {c === 'copy_to_patrolkit' && deleted ? 'Copy to PatrolKit as new' : c === 'set_stock' ? `Set Square’s stock to ${issue.ours?.stock ?? 0}` : CHOICE_LABEL[c]}
            </button>
          ))}
          {apply.isPending && <span className="text-xs text-gray-400">Working…</span>}
        </div>
      )}
    </div>
  );
}
