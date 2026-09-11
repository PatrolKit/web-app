import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowUpRightFromSquare as faPromoteDuo,
  faCheck as faCheckDuo,
  faRightLeft as faMergeDuo,
  faTrash as faTrashDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { taxonomyIcon } from '../../lib/taxonomyIcons';
import type { OrgTaxonomyAdmin, TaxonomyAdminNode } from '../../lib/api.types';

/**
 * The org's half of the item-description tree (Plan 19 §6.3).
 *
 * Two lists and a read-only third. The queue is what a seller typing a brand at
 * the counter produces; the club's own values are what it has approved; the
 * shared list is visible and not editable here, because an org that wants a
 * global change asks for one (D10).
 */

function relative(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function NodeIconPreview({ node }: { node: TaxonomyAdminNode }) {
  if (node.iconUrl) return <img src={node.iconUrl} alt="" className="h-4 w-4 object-contain" />;
  const def = taxonomyIcon(node.iconKey);
  if (!def) return <span className="text-xs text-gray-600">no icon</span>;
  return <FontAwesomeIcon icon={def} className="h-4 w-4 text-gray-400" />;
}

export default function ItemDetailsCard({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const queryKey = ['ski-swap/taxonomy-admin', orgId];
  const [error, setError] = useState('');

  const { data, isLoading } = useQuery<OrgTaxonomyAdmin>({
    queryKey,
    queryFn: () => api.skiSwap.taxonomyAdmin(orgId),
    enabled: !!orgId,
  });

  /** Every write here invalidates the tree too: the picker's list just moved. */
  function afterWrite() {
    void qc.invalidateQueries({ queryKey });
    void qc.invalidateQueries({ queryKey: ['taxonomy', orgId] });
    void qc.invalidateQueries({ queryKey: ['taxonomy/children', orgId] });
  }

  const fail = (err: unknown) =>
    setError(err instanceof ApiError ? err.message : 'That did not work');

  const approve = useMutation({
    mutationFn: (nodeId: string) => api.skiSwap.patchTaxonomyNode(orgId, nodeId, { approve: true }),
    onSuccess: () => { setError(''); afterWrite(); },
    onError: fail,
  });

  const merge = useMutation({
    mutationFn: (v: { nodeId: string; targetId: string }) =>
      api.skiSwap.mergeTaxonomyNode(orgId, v.nodeId, v.targetId),
    onSuccess: () => { setError(''); afterWrite(); },
    onError: fail,
  });

  const discard = useMutation({
    mutationFn: (nodeId: string) => api.skiSwap.discardTaxonomyNode(orgId, nodeId),
    onSuccess: () => { setError(''); afterWrite(); },
    onError: fail,
  });

  const suggest = useMutation({
    mutationFn: (nodeId: string) => api.skiSwap.suggestTaxonomyNode(orgId, nodeId),
    onSuccess: () => { setError(''); afterWrite(); },
    onError: fail,
  });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;
  if (!data) return null;

  const values = data.own.filter((n) => n.kind === 'VALUE');

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-white font-semibold">Item details</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          What sellers pick from when they describe an item. The shared list comes
          with PatrolKit; anything your club adds lives alongside it.
        </p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* ── The queue ──────────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          Waiting for approval{data.pending.length > 0 ? ` (${data.pending.length})` : ''}
        </h3>

        {data.pending.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing waiting. A value a seller types that is not on the list shows
            up here.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.pending.map(({ node, similar }) => (
              <li key={node.id} className="bg-surface-100 border border-gray-700 rounded-lg px-3 py-2.5 space-y-2">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm text-white truncate">“{node.label}”</p>
                    <p className="text-xs text-gray-500">
                      {node.path} · {relative(node.createdAt)} ·{' '}
                      {node.itemCount} item{node.itemCount === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>

                {/* A near match is the difference between a taxonomy and a pile:
                    one click to fold them together rather than a judgement. */}
                {similar && (
                  <div className="flex items-center justify-between gap-2 bg-surface-200 rounded px-2 py-1.5">
                    <span className="text-xs text-gray-300">
                      Similar: {similar.label}
                      {similar.scope === 'global' ? ' (shared list)' : ' (your club)'}
                    </span>
                    <button
                      className="text-xs text-brand-400 hover:text-brand-300 whitespace-nowrap"
                      disabled={merge.isPending}
                      onClick={() => merge.mutate({ nodeId: node.id, targetId: similar.id })}
                    >
                      <FontAwesomeIcon icon={faMergeDuo} /> Use that instead
                    </button>
                  </div>
                )}

                <div className="flex gap-2">
                  <button
                    className="text-xs px-2.5 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40"
                    disabled={approve.isPending}
                    onClick={() => approve.mutate(node.id)}
                  >
                    <FontAwesomeIcon icon={faCheckDuo} /> Approve
                  </button>
                  {/*
                    Disabled while anything uses it, which is every fresh pending
                    value — one created it. The count is the reason, rather than a
                    constraint error after the click (D4).
                  */}
                  <button
                    className="text-xs px-2.5 py-1.5 rounded bg-surface-200 hover:bg-surface-300 text-gray-300 disabled:opacity-40"
                    disabled={discard.isPending || node.itemCount > 0}
                    title={
                      node.itemCount > 0
                        ? `${node.itemCount} item${node.itemCount === 1 ? '' : 's'} use this. Approve it, or use an existing value instead.`
                        : undefined
                    }
                    onClick={() => discard.mutate(node.id)}
                  >
                    <FontAwesomeIcon icon={faTrashDuo} /> Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── The club's own ─────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-medium text-gray-300 mb-2">
          Your club’s values{values.length > 0 ? ` (${values.length})` : ''}
        </h3>

        {values.length === 0 ? (
          <p className="text-sm text-gray-500">
            None yet. Approve something above and it appears here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {values.map((node) => (
              <li
                key={node.id}
                className="flex items-center gap-3 bg-surface-100 border border-gray-700 rounded px-3 py-2"
              >
                <NodeIconPreview node={node} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white truncate">{node.label}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {node.path} · {node.itemCount} item{node.itemCount === 1 ? '' : 's'}
                  </p>
                </div>
                {/* The org asks; a platform admin decides (D10). */}
                {node.suggestedAt ? (
                  <span className="text-xs text-gray-500 whitespace-nowrap">Suggested</span>
                ) : (
                  <button
                    className="text-xs text-brand-400 hover:text-brand-300 whitespace-nowrap disabled:opacity-40"
                    disabled={suggest.isPending}
                    onClick={() => suggest.mutate(node.id)}
                  >
                    <FontAwesomeIcon icon={faPromoteDuo} /> Suggest for everyone
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
