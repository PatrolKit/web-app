import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowDownAZ as faSortDuo,
  faArrowDown as faDownDuo,
  faArrowUp as faUpDuo,
  faArrowUpRightFromSquare as faPromoteDuo,
  faChevronDown as faChevronDownDuo,
  faChevronRight as faChevronRightDuo,
  faEyeSlash as faRetireDuo,
  faImage as faImageDuo,
  faPlus as faPlusDuo,
  faXmark as faXmarkDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { TAXONOMY_ICON_KEYS, taxonomyIcon } from '../../lib/taxonomyIcons';
import type { TaxonomyAdminNode, TaxonomySuggestion } from '../../lib/api.types';

/**
 * The shared item-description tree (Plan 19 §6.4).
 *
 * A tree editor and a promotion inbox. Editing here changes what every
 * organization sees, which is why it is super-admin only and why a rename warns
 * rather than just saving: an org asks for a global change, it does not make
 * one.
 */

// ─── The icon picker ─────────────────────────────────────────────────────────

/**
 * The registry grid first, an upload behind it (§4.4).
 *
 * That order is the whole argument: a registry icon costs no request and is
 * theme-correct for free, so an upload is for what the registry does not cover
 * rather than the first thing reached for.
 */
function IconPicker({
  node, onClose, onChanged,
}: {
  node: TaxonomyAdminNode;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<'registry' | 'upload'>('registry');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const keys = useMemo(
    () => TAXONOMY_ICON_KEYS.filter((k) => k.includes(search.trim().toLowerCase())),
    [search],
  );

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error)?.message ?? 'That did not work');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-200 rounded-lg p-5 w-full max-w-lg space-y-4 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Icon for “{node.label}”</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
            <FontAwesomeIcon icon={faXmarkDuo} />
          </button>
        </div>

        <div className="flex gap-1 border-b border-gray-700 pb-2">
          {(['registry', 'upload'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded text-sm ${
                tab === t ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {t === 'registry' ? 'Built in' : 'Upload an image'}
            </button>
          ))}
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {tab === 'registry' ? (
          <>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
            />
            <div className="grid grid-cols-6 sm:grid-cols-8 gap-1.5">
              {keys.map((key) => {
                const def = taxonomyIcon(key);
                if (!def) return null;
                const on = node.iconKey === key;
                return (
                  <button
                    key={key}
                    title={key}
                    disabled={busy}
                    onClick={() => run(() => api.taxonomyAdmin.patch(node.id, { iconKey: key }))}
                    className={`aspect-square rounded border flex items-center justify-center ${
                      on ? 'bg-brand-600 border-brand-600 text-white' : 'bg-surface-100 border-gray-700 text-gray-300 hover:bg-surface-300'
                    }`}
                  >
                    <FontAwesomeIcon icon={def} />
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-gray-400">
              PNG, JPEG, WebP or SVG, up to 2MB. Whatever you send is re-encoded
              to a 128×128 PNG, so an SVG arrives flattened.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="block w-full text-sm text-gray-300"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void run(() => api.taxonomyAdmin.uploadIcon(node.id, file));
              }}
            />
            {node.iconUrl && (
              <div className="flex items-center gap-3">
                <img src={node.iconUrl} alt="" className="h-10 w-10 object-contain" />
                <button
                  disabled={busy}
                  onClick={() => run(() => api.taxonomyAdmin.deleteIcon(node.id))}
                  className="text-sm text-gray-400 hover:text-gray-200"
                >
                  Remove this image
                </button>
              </div>
            )}
          </div>
        )}

        {/* The default, and it has to look like a choice rather than an empty
            state — most nodes are a word, and a row where three have pictures
            and five do not looks broken. */}
        <button
          disabled={busy}
          onClick={() => run(() => api.taxonomyAdmin.patch(node.id, { iconKey: null }))}
          className="text-sm text-gray-400 hover:text-gray-200"
        >
          No icon
        </button>
      </div>
    </div>
  );
}

// ─── Adding a node ───────────────────────────────────────────────────────────

function AddNodeForm({
  parent, onClose, onAdded,
}: {
  /** Null ⇒ a new root category. */
  parent: TaxonomyAdminNode | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  // What may be added depends on what it hangs off — the alternation the tree
  // is made of (§2.1). Under a category or a value, a question; under a
  // question, an answer.
  const kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE' =
    parent === null ? 'CATEGORY' : parent.kind === 'ATTRIBUTE' ? 'VALUE' : 'ATTRIBUTE';

  const [label, setLabel] = useState('');
  const [input, setInput] = useState<'SELECT' | 'NUMBER'>('SELECT');
  const [nameSlot, setNameSlot] = useState('');
  const [unit, setUnit] = useState('');
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [step, setStep] = useState('');
  const [allowFreeEntry, setAllowFreeEntry] = useState(false);
  const [error, setError] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api.taxonomyAdmin.create({
        kind,
        ...(parent ? { parentId: parent.id } : {}),
        label: label.trim(),
        ...(kind === 'ATTRIBUTE'
          ? {
              input,
              nameSlot: nameSlot.trim() === '' ? null : Number(nameSlot),
              ...(input === 'NUMBER'
                ? {
                    unit: unit.trim() || null,
                    minValue: min.trim() === '' ? null : Number(min),
                    maxValue: max.trim() === '' ? null : Number(max),
                    step: step.trim() === '' ? null : Number(step),
                  }
                : { allowFreeEntry }),
            }
          : {}),
      }),
    onSuccess: () => { onAdded(); onClose(); },
    onError: (err: unknown) =>
      setError(err instanceof ApiError ? err.message : 'Could not add that'),
  });

  const noun = kind === 'CATEGORY' ? 'category' : kind === 'ATTRIBUTE' ? 'question' : 'answer';

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      {/* Capped and scrolled for the same reason as the item form: a NUMBER
          question adds four more fields, and a centred box that outgrows the
          viewport puts its own heading out of reach. */}
      <form
        className="bg-surface-200 rounded-lg p-5 w-full max-w-md space-y-3 max-h-[calc(100vh-2rem)] overflow-y-auto"
        onSubmit={(e) => { e.preventDefault(); add.mutate(); }}
      >
        <h3 className="text-white font-semibold">
          New {noun}
          {parent ? <span className="text-gray-400 font-normal"> under {parent.label}</span> : null}
        </h3>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <input
          autoFocus
          required
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={kind === 'ATTRIBUTE' ? 'e.g. Manufacturer' : 'e.g. Skis'}
          className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
        />

        {kind === 'ATTRIBUTE' && (
          <>
            <div className="flex gap-2">
              {(['SELECT', 'NUMBER'] as const).map((i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setInput(i)}
                  className={`px-3 py-1.5 rounded text-sm ${
                    input === i ? 'bg-brand-600 text-white' : 'bg-surface-100 text-gray-300'
                  }`}
                >
                  {i === 'SELECT' ? 'Pick from a list' : 'Type a number'}
                </button>
              ))}
            </div>

            <label className="block">
              <span className="block text-xs text-gray-400 mb-1">
                Position in the name — blank means this detail is captured but not named
              </span>
              <input
                value={nameSlot}
                onChange={(e) => setNameSlot(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 10"
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              />
            </label>

            {input === 'NUMBER' ? (
              <div className="grid grid-cols-4 gap-2">
                {([['Unit', unit, setUnit, 'cm'], ['Min', min, setMin, '70'], ['Max', max, setMax, '215'], ['Step', step, setStep, '1']] as const).map(
                  ([name, val, set, ph]) => (
                    <label key={name} className="block">
                      <span className="block text-xs text-gray-400 mb-1">{name}</span>
                      <input
                        value={val}
                        onChange={(e) => (set as (v: string) => void)(e.target.value)}
                        placeholder={ph}
                        className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-2 text-sm text-white"
                      />
                    </label>
                  ),
                )}
              </div>
            ) : (
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={allowFreeEntry}
                  onChange={(e) => setAllowFreeEntry(e.target.checked)}
                />
                Let sellers type an answer that is not listed
              </label>
            )}
          </>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="submit"
            disabled={add.isPending || !label.trim()}
            className="px-4 py-2 rounded bg-brand-600 hover:bg-brand-700 text-white text-sm disabled:opacity-40"
          >
            {add.isPending ? 'Adding…' : 'Add'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded bg-surface-100 hover:bg-surface-300 text-gray-300 text-sm"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Reordering ──────────────────────────────────────────────────────────────

/**
 * Moves one node within its siblings.
 *
 * `displayOrder` decided the order all along — the resolver, the deferred-branch
 * fetch and the exporter all sort on it — but until now only the seed ever wrote
 * one, and only when creating a node. So anything added through this screen
 * landed at the bottom of its group with no way to lift it.
 *
 * Renumbers the whole group to 10, 20, 30… and writes back only the rows that
 * actually changed. A plain swap of two values would be one fewer thing to think
 * about, and would also be a no-op wherever two siblings share an order — which
 * the seed can produce, because it numbers by array position and never revisits
 * an existing node. Renumbering heals those as it goes, and in the ordinary case
 * of distinct orders it still writes exactly two rows.
 */
async function moveWithinSiblings(
  siblings: TaxonomyAdminNode[],
  from: number,
  to: number,
): Promise<number> {
  const reordered = [...siblings];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return applyOrder(reordered);
}

/**
 * Writes an intended order back, in one request.
 *
 * It was one PATCH per row to begin with, which sorted thirty-seven
 * manufacturers in fourteen seconds and bumped every org's taxonomy version
 * thirty-seven times on the way. Reordering is one act, so it is now one call:
 * the server assigns the numbers, writes them in a transaction, and bumps once.
 */
async function applyOrder(ordered: TaxonomyAdminNode[]): Promise<number> {
  const { moved } = await api.taxonomyAdmin.reorder(ordered.map((n) => n.id));
  return moved;
}

/**
 * Sorts one group by label, once.
 *
 * Deliberately a one-shot and not a property of the attribute: nothing here
 * remembers the choice, so a value approved from the queue next week lands at
 * the end like any other new node and the button is pressed again. That is the
 * right trade for a list somebody curates and the wrong one for a list that
 * grows on its own — a `sortValues` flag on the attribute is the durable answer
 * if manufacturer lists start drifting faster than anyone wants to re-sort them.
 *
 * `sensitivity: 'base'` so Völkl files under V rather than after Z, matching how
 * `dedupeKey` already folds accents; `numeric` so SS107 precedes SS127 instead
 * of sorting as text.
 */
function alphabetically(nodes: TaxonomyAdminNode[]): TaxonomyAdminNode[] {
  return [...nodes].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }),
  );
}

/**
 * One level of the tree, which is also the unit reordering works in.
 *
 * A row cannot move itself: it has no idea what it sits beside. The list owns
 * the sibling array, so it owns the move.
 */
function NodeList({
  nodes, depth, onEditIcon, onAddUnder, onChanged, onError,
}: {
  nodes: TaxonomyAdminNode[];
  depth: number;
  onEditIcon: (node: TaxonomyAdminNode) => void;
  onAddUnder: (node: TaxonomyAdminNode) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [moving, setMoving] = useState(false);

  async function move(from: number, to: number) {
    if (to < 0 || to >= nodes.length || moving) return;
    setMoving(true);
    try {
      await moveWithinSiblings(nodes, from, to);
      onChanged();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not reorder that');
    } finally {
      setMoving(false);
    }
  }

  return (
    <ul>
      {nodes.map((n, i) => (
        <NodeRow
          key={n.id}
          node={n}
          depth={depth}
          index={i}
          count={nodes.length}
          busy={moving}
          onMove={(dir) => void move(i, dir === 'up' ? i - 1 : i + 1)}
          onEditIcon={onEditIcon}
          onAddUnder={onAddUnder}
          onChanged={onChanged}
          onError={onError}
        />
      ))}
    </ul>
  );
}

// ─── One row of the tree ─────────────────────────────────────────────────────

function NodeRow({
  node, depth, index, count, busy, onMove, onEditIcon, onAddUnder, onChanged, onError,
}: {
  node: TaxonomyAdminNode;
  depth: number;
  /** Where this row sits among its siblings, which is what a move is relative to. */
  index: number;
  count: number;
  busy: boolean;
  onMove: (direction: 'up' | 'down') => void;
  onEditIcon: (node: TaxonomyAdminNode) => void;
  onAddUnder: (node: TaxonomyAdminNode) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  // Categories open; everything below starts closed, because a manufacturer list
  // expanded by default buries the next category off the bottom of the screen.
  const [open, setOpen] = useState(depth === 0 && node.kind === 'CATEGORY');
  const [renaming, setRenaming] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [label, setLabel] = useState(node.label);

  const children = node.children ?? [];
  const icon = taxonomyIcon(node.iconKey);

  const rename = useMutation({
    mutationFn: () => api.taxonomyAdmin.patch(node.id, { label: label.trim() }),
    onSuccess: () => { setRenaming(false); onChanged(); },
  });

  const retire = useMutation({
    mutationFn: () => api.taxonomyAdmin.patch(node.id, { retired: node.retiredAt === null }),
    onSuccess: onChanged,
  });

  return (
    <li>
      <div
        className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-surface-100 group"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {children.length > 0 ? (
          <button onClick={() => setOpen(!open)} className="text-gray-500 w-4">
            <FontAwesomeIcon icon={open ? faChevronDownDuo : faChevronRightDuo} />
          </button>
        ) : (
          <span className="w-4" />
        )}

        {node.iconUrl ? (
          <img src={node.iconUrl} alt="" className="h-4 w-4 object-contain" />
        ) : icon ? (
          <FontAwesomeIcon icon={icon} className="h-4 w-4 text-gray-400" />
        ) : (
          <span className="w-4" />
        )}

        {renaming ? (
          <input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') rename.mutate();
              if (e.key === 'Escape') { setLabel(node.label); setRenaming(false); }
            }}
            onBlur={() => { setLabel(node.label); setRenaming(false); }}
            className="bg-surface-100 border border-brand-600 rounded px-2 py-0.5 text-sm text-white"
          />
        ) : (
          <button
            onClick={() => setRenaming(true)}
            className={`text-sm text-left ${node.retiredAt ? 'text-gray-600 line-through' : 'text-white'}`}
          >
            {node.label}
          </button>
        )}

        <span className="text-xs text-gray-600">
          {node.kind === 'ATTRIBUTE'
            ? `${node.input === 'NUMBER' ? 'number' : 'list'}${node.nameSlot !== null ? ` · slot ${node.nameSlot}` : ' · unnamed'}${node.allowFreeEntry ? ' · open' : ''}`
            : node.itemCount > 0
              ? `${node.itemCount} item${node.itemCount === 1 ? '' : 's'}`
              : ''}
        </span>

        <span className="flex-1" />

        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Disabled at the ends rather than hidden, so the control does not
              move under the pointer as a row reaches the top or bottom. */}
          <button
            title="Move up"
            disabled={busy || index === 0}
            onClick={() => onMove('up')}
            className="text-xs text-gray-400 hover:text-gray-200 px-1.5 py-0.5 disabled:opacity-25 disabled:hover:text-gray-400"
          >
            <FontAwesomeIcon icon={faUpDuo} />
          </button>
          <button
            title="Move down"
            disabled={busy || index === count - 1}
            onClick={() => onMove('down')}
            className="text-xs text-gray-400 hover:text-gray-200 px-1.5 py-0.5 disabled:opacity-25 disabled:hover:text-gray-400"
          >
            <FontAwesomeIcon icon={faDownDuo} />
          </button>
          {/* On the parent, not the children: "sort these" is a statement about
              a group, and the group is addressable exactly here. Hidden for a
              single child, where it could only be a no-op. */}
          {children.length > 1 && (
            <button
              title={`Sort ${children.length} items A–Z`}
              disabled={sorting}
              onClick={async () => {
                if (!window.confirm(
                  `Sort the ${children.length} items under “${node.label}” alphabetically?`,
                )) return;
                setSorting(true);
                try {
                  await applyOrder(alphabetically(children));
                  onChanged();
                } catch (err) {
                  onError(err instanceof ApiError ? err.message : 'Could not sort those');
                } finally {
                  setSorting(false);
                }
              }}
              className="text-xs text-gray-400 hover:text-gray-200 px-1.5 py-0.5 disabled:opacity-25"
            >
              <FontAwesomeIcon icon={faSortDuo} />
            </button>
          )}
          <button
            title="Icon"
            onClick={() => onEditIcon(node)}
            className="text-xs text-gray-400 hover:text-gray-200 px-1.5 py-0.5"
          >
            <FontAwesomeIcon icon={faImageDuo} />
          </button>
          {node.kind !== 'VALUE' || node.input === null ? (
            <button
              title="Add under this"
              onClick={() => onAddUnder(node)}
              className="text-xs text-gray-400 hover:text-gray-200 px-1.5 py-0.5"
            >
              <FontAwesomeIcon icon={faPlusDuo} />
            </button>
          ) : null}
          {/* Retire, never delete: a node an item points at has to stay
              readable, and this is how it leaves the tree instead (D4). */}
          <button
            title={node.retiredAt ? 'Bring back' : 'Retire'}
            onClick={() => retire.mutate()}
            className="text-xs text-gray-400 hover:text-gray-200 px-1.5 py-0.5"
          >
            <FontAwesomeIcon icon={faRetireDuo} />
          </button>
        </div>
      </div>

      {open && children.length > 0 && (
        <NodeList
          nodes={children}
          depth={depth + 1}
          onEditIcon={onEditIcon}
          onAddUnder={onAddUnder}
          onChanged={onChanged}
          onError={onError}
        />
      )}
    </li>
  );
}

// ─── The tab ─────────────────────────────────────────────────────────────────

export default function ItemTaxonomyTab() {
  const qc = useQueryClient();
  const [iconFor, setIconFor] = useState<TaxonomyAdminNode | null>(null);
  const [addUnder, setAddUnder] = useState<TaxonomyAdminNode | null | undefined>(undefined);
  const [error, setError] = useState('');

  const { data: tree, isLoading } = useQuery<TaxonomyAdminNode[]>({
    queryKey: ['admin/taxonomy'],
    queryFn: () => api.taxonomyAdmin.tree(),
  });

  const { data: suggestions } = useQuery<TaxonomySuggestion[]>({
    queryKey: ['admin/taxonomy/suggestions'],
    queryFn: () => api.taxonomyAdmin.suggestions(),
  });

  const changed = () => {
    void qc.invalidateQueries({ queryKey: ['admin/taxonomy'] });
    void qc.invalidateQueries({ queryKey: ['admin/taxonomy/suggestions'] });
  };

  const promote = useMutation({
    mutationFn: (nodeId: string) => api.taxonomyAdmin.promote(nodeId),
    onSuccess: () => { setError(''); changed(); },
    onError: (err: unknown) =>
      setError(err instanceof ApiError ? err.message : 'Could not promote that'),
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-8">
      {/* ── The promotion inbox ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          <h2 className="text-white font-semibold">
            Suggested for everyone{suggestions?.length ? ` (${suggestions.length})` : ''}
          </h2>
          <p className="text-sm text-gray-400 mt-0.5">
            Values a patrol has asked to add to the shared list. Promoting one moves
            it out of that patrol and into every org’s tree.
          </p>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        {!suggestions?.length ? (
          <p className="text-sm text-gray-500">Nothing suggested.</p>
        ) : (
          <ul className="space-y-2">
            {suggestions.map((s) => (
              <li
                key={s.node.id}
                className="flex items-center gap-3 bg-surface-100 border border-gray-700 rounded px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white truncate">
                    {s.node.label}
                    {/* A collision means promoting folds it into what is already
                        there — the payoff of the two-tier scheme (§8.4). */}
                    {s.collision && (
                      <span className="text-amber-400 text-xs ml-2">
                        merges into existing “{s.collision.label}”
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {s.node.path} · {s.orgName} · {s.node.itemCount} item
                    {s.node.itemCount === 1 ? '' : 's'}
                    {!s.ancestorsGlobal && ' · its question is not shared yet, so that is promoted too'}
                  </p>
                </div>
                <button
                  disabled={promote.isPending}
                  onClick={() => promote.mutate(s.node.id)}
                  className="text-xs px-2.5 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-40 whitespace-nowrap"
                >
                  <FontAwesomeIcon icon={faPromoteDuo} /> Promote
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── The tree ───────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-white font-semibold">The shared list</h2>
            <p className="text-sm text-gray-400 mt-0.5">
              What every organization sees. Click a label to rename it. Renaming
              changes what new items say and leaves every existing item’s name
              exactly as it was printed.
            </p>
          </div>
          <button
            onClick={() => setAddUnder(null)}
            className="px-3 py-1.5 rounded bg-brand-600 hover:bg-brand-700 text-white text-sm whitespace-nowrap"
          >
            <FontAwesomeIcon icon={faPlusDuo} /> Category
          </button>
        </div>

        <div className="bg-surface-50 border border-gray-800 rounded-lg py-1">
          <NodeList
            nodes={tree ?? []}
            depth={0}
            onEditIcon={setIconFor}
            onAddUnder={setAddUnder}
            onChanged={changed}
            onError={setError}
          />
        </div>
      </section>

      {iconFor && (
        <IconPicker node={iconFor} onClose={() => setIconFor(null)} onChanged={changed} />
      )}
      {addUnder !== undefined && (
        <AddNodeForm parent={addUnder} onClose={() => setAddUnder(undefined)} onAdded={changed} />
      )}
    </div>
  );
}
