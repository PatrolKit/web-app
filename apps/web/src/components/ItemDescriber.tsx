import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown as faChevronDownDuo, faPlus as faPlusDuo } from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../lib/api';
import { taxonomyIcon } from '../lib/taxonomyIcons';
import SearchableSelect from './SearchableSelect';
import type {
  ItemAttributeInput,
  ResolvedAttribute,
  ResolvedCategory,
  ResolvedIcon,
  ResolvedTaxonomy,
  ResolvedValue,
} from '../lib/api.types';

/**
 * Describing an item by picking (Plan 19 §6.1, §6.2).
 *
 * One component for both surfaces. The phone gets `layout="stacked"` and hides
 * the tail of the questions behind "More detail"; the desktop panel gets
 * `layout="grid"` and shows them all. Nothing else differs, because the form is
 * the same fold over the same resolved tree either way.
 */

/** Where an answer lives while it is being edited. */
export interface DescriberAnswer {
  /** A listed value. */
  valueId?: string;
  numberValue?: string;
  /** Typed, and not on the list yet. Becomes a pending value on save. */
  freeText?: string;
}

export interface DescriberState {
  categoryId: string | null;
  /** Keyed by attribute id. */
  answers: Record<string, DescriberAnswer>;
}

export const emptyDescriber: DescriberState = { categoryId: null, answers: {} };

/** What the server wants, out of what the form holds. */
export function toAttributeInputs(state: DescriberState): ItemAttributeInput[] {
  return Object.entries(state.answers).flatMap(([attributeId, a]): ItemAttributeInput[] => {
    if (a.valueId) return [{ attributeId, valueId: a.valueId }];
    if (a.freeText?.trim()) return [{ attributeId, freeText: a.freeText.trim() }];
    if (a.numberValue !== undefined && a.numberValue.trim() !== '') {
      const n = Number(a.numberValue);
      return Number.isFinite(n) ? [{ attributeId, numberValue: n }] : [];
    }
    // A control the seller cleared. Not an answer, and not an error.
    return [];
  });
}

/**
 * How many questions a phone shows before the rest collapse.
 *
 * Four fits above the iOS keyboard alongside the price and the finish button,
 * which is the constraint the whole screen is laid out around.
 */
const VISIBLE_ON_PHONE = 4;

// ─── The name preview ────────────────────────────────────────────────────────

/**
 * What the item will be called, composed the way the server will compose it.
 *
 * A local copy of `deriveName` rather than a round trip per keystroke. The server
 * still composes the real one on save — this is the feedback loop that shows a
 * seller their listing improving as they answer, and being a keystroke behind
 * the truth would cost nothing but being a request behind it would.
 */
export function previewName(
  state: DescriberState,
  category: ResolvedCategory | undefined,
  attributesById: Map<string, ResolvedAttribute>,
  valueLabelById: Map<string, string>,
): string {
  if (!category) return '';
  const parts = Object.entries(state.answers)
    .map(([attributeId, answer]) => ({ attribute: attributesById.get(attributeId), answer }))
    .filter((x): x is { attribute: ResolvedAttribute; answer: DescriberAnswer } => !!x.attribute)
    .filter((x) => x.attribute.nameSlot !== null)
    .sort((a, b) => (a.attribute.nameSlot ?? 0) - (b.attribute.nameSlot ?? 0) || a.attribute.displayOrder - b.attribute.displayOrder)
    .map(({ attribute, answer }) => {
      if (answer.valueId) return valueLabelById.get(answer.valueId) ?? '';
      if (answer.freeText?.trim()) return answer.freeText.trim();
      if (answer.numberValue !== undefined && answer.numberValue.trim() !== '') {
        const n = Number(answer.numberValue);
        if (!Number.isFinite(n)) return '';
        const digits = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
        return `${digits}${attribute.unit ?? ''}`;
      }
      return '';
    })
    .filter((p) => p !== '');

  return [...parts, category.label].join(' ').replace(/\s+/g, ' ').trim();
}

// ─── Bits ────────────────────────────────────────────────────────────────────

/**
 * A node's icon, or nothing.
 *
 * A key this build does not know renders as no icon rather than a placeholder:
 * a missing glyph should be invisible, not a broken frame (§4.2).
 */
function NodeIcon({ icon, className }: { icon?: ResolvedIcon; className?: string }) {
  if (!icon) return null;
  if (icon.kind === 'image') {
    // Decorative: the label beside it is already the accessible name.
    return <img src={icon.url} alt="" loading="lazy" className={className ?? 'h-5 w-5 object-contain'} />;
  }
  const def = taxonomyIcon(icon.key);
  if (!def) return null;
  return <FontAwesomeIcon icon={def} className={className} />;
}

/** Chips, for a short closed list. One tap, no dropdown, no keyboard. */
function ValueChips({
  values, selected, onPick,
}: {
  values: ResolvedValue[];
  selected: string | undefined;
  onPick: (valueId: string | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((v) => {
        const on = selected === v.id;
        return (
          <button
            key={v.id}
            type="button"
            // Tapping the chosen one clears it: every question is optional, and
            // a seller who picked the wrong thing needs a way back out.
            onClick={() => onPick(on ? undefined : v.id)}
            className={`px-2.5 py-1.5 rounded-lg text-sm border flex items-center gap-1.5 ${
              on
                ? 'bg-brand-600 border-brand-600 text-white'
                : 'bg-surface-100 border-gray-700 text-gray-200 hover:bg-surface-200'
            }`}
          >
            <NodeIcon icon={v.icon} className="h-3.5 w-3.5" />
            {v.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A long list, or one that takes free entry.
 *
 * `SearchableSelect` handles the listed values; the free-entry row sits beside
 * it, because the select cannot offer something it has never heard of.
 */
function ValueSelect({
  attribute, values, answer, onChange,
}: {
  attribute: ResolvedAttribute;
  values: ResolvedValue[];
  answer: DescriberAnswer;
  onChange: (next: DescriberAnswer) => void;
}) {
  const [typed, setTyped] = useState('');

  const options = useMemo(
    () => values.map((v) => ({ value: v.id, label: v.label })),
    [values],
  );

  // A value typed on a previous render, held until the item is saved.
  const pendingLabel = answer.freeText?.trim();

  return (
    <div className="space-y-1.5">
      <SearchableSelect
        value={answer.valueId ?? ''}
        onChange={(valueId) => onChange(valueId ? { valueId } : {})}
        options={options}
        placeholder={pendingLabel ? `${pendingLabel} — new` : `Choose ${attribute.label.toLowerCase()}…`}
        clearLabel="Not sure"
      />
      {attribute.allowFreeEntry && (
        <div className="flex gap-1.5">
          <input
            className="flex-1 bg-surface-100 border border-gray-700 rounded-lg px-2.5 py-2 text-sm text-white placeholder:text-gray-500 focus:border-brand-600 focus:outline-none"
            placeholder="Not listed? Type it"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typed.trim()) {
                e.preventDefault();
                onChange({ freeText: typed.trim() });
                setTyped('');
              }
            }}
          />
          <button
            type="button"
            disabled={!typed.trim()}
            onClick={() => { onChange({ freeText: typed.trim() }); setTyped(''); }}
            className="px-3 rounded-lg bg-surface-100 border border-gray-700 text-gray-200 text-sm hover:bg-surface-200 disabled:opacity-40"
          >
            <FontAwesomeIcon icon={faPlusDuo} />
          </button>
        </div>
      )}
      {pendingLabel && (
        <p className="text-xs text-amber-400">
          “{pendingLabel}” is new — it will be added for your club to approve.
        </p>
      )}
    </div>
  );
}

/** One question, and whatever its answer opens up beneath it. */
function AttributeField({
  orgId, attribute, state, setAnswer, depth, onValuesLoaded,
}: {
  orgId: string;
  attribute: ResolvedAttribute;
  state: DescriberState;
  setAnswer: (attributeId: string, next: DescriberAnswer) => void;
  depth: number;
  onValuesLoaded: (values: ResolvedValue[]) => void;
}) {
  const answer = state.answers[attribute.id] ?? {};

  /**
   * A deferred branch — a manufacturer's model list — fetched on first render of
   * the control rather than with the tree (§7.2).
   *
   * Only once the control is actually on screen, which for a value's attributes
   * means only once that value was chosen. Cached by the query key, so going
   * back and forth between two manufacturers costs one fetch each.
   */
  const { data: deferred, isLoading } = useQuery({
    queryKey: ['taxonomy/children', orgId, attribute.id],
    queryFn: () => api.skiSwap.taxonomyChildren(orgId, attribute.id),
    enabled: attribute.input === 'select' && !!attribute.valuesDeferred,
    staleTime: 5 * 60 * 1000,
  });

  const values = useMemo(
    () => attribute.values ?? deferred?.values ?? [],
    [attribute.values, deferred],
  );

  useEffect(() => {
    if (values.length) onValuesLoaded(values);
  }, [values, onValuesLoaded]);

  const chosen = answer.valueId ? values.find((v) => v.id === answer.valueId) : undefined;

  return (
    <div className={depth > 0 ? 'pl-3 border-l border-gray-800 space-y-1.5' : 'space-y-1.5'}>
      <label className="flex items-center gap-1.5 text-xs font-medium text-gray-400">
        <NodeIcon icon={attribute.icon} className="h-3.5 w-3.5" />
        {attribute.label}
        {attribute.unit ? <span className="text-gray-600">({attribute.unit})</span> : null}
      </label>

      {attribute.input === 'number' ? (
        <div className="flex items-center gap-2">
          <input
            className="w-28 bg-surface-100 border border-gray-700 rounded-lg px-2.5 py-2 text-sm text-white placeholder:text-gray-500 focus:border-brand-600 focus:outline-none"
            inputMode="decimal"
            placeholder={attribute.min !== undefined ? `${attribute.min}–${attribute.max ?? ''}` : ''}
            value={answer.numberValue ?? ''}
            onChange={(e) => setAnswer(attribute.id, { numberValue: e.target.value })}
          />
          {attribute.unit ? <span className="text-sm text-gray-500">{attribute.unit}</span> : null}
        </div>
      ) : isLoading ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : values.length === 0 && !attribute.allowFreeEntry ? (
        <p className="text-xs text-gray-600">Nothing to choose from yet.</p>
      ) : values.length > 8 || attribute.allowFreeEntry ? (
        <ValueSelect
          attribute={attribute}
          values={values}
          answer={answer}
          onChange={(next) => setAnswer(attribute.id, next)}
        />
      ) : (
        <ValueChips
          values={values}
          selected={answer.valueId}
          onPick={(valueId) => setAnswer(attribute.id, valueId ? { valueId } : {})}
        />
      )}

      {/* The branch: questions that only this answer opens. Indented one level
          and no more — a phone has no room for a third rail (§4.2). */}
      {chosen?.attributes.map((child) => (
        <AttributeField
          key={child.id}
          orgId={orgId}
          attribute={child}
          state={state}
          setAnswer={setAnswer}
          depth={Math.min(depth + 1, 1)}
          onValuesLoaded={onValuesLoaded}
        />
      ))}
    </div>
  );
}

// ─── The component ───────────────────────────────────────────────────────────

export interface ItemDescriberProps {
  orgId: string;
  value: DescriberState;
  onChange: (next: DescriberState) => void;
  layout?: 'stacked' | 'grid';
  /** Rendered under the questions, so the preview sits beside the price. */
  renderPreview?: (name: string) => React.ReactNode;
}

export default function ItemDescriber({
  orgId, value, onChange, layout = 'stacked', renderPreview,
}: ItemDescriberProps) {
  const [expanded, setExpanded] = useState(false);
  /**
   * Labels for values that arrived through a deferred fetch.
   *
   * The preview needs a label for whatever was picked, and a model's label is
   * not in the eager tree. Collected as branches load rather than re-fetched.
   */
  const [valueLabels, setValueLabels] = useState<Map<string, string>>(new Map());

  const { data: taxonomy, isLoading, error } = useQuery<ResolvedTaxonomy>({
    queryKey: ['taxonomy', orgId],
    queryFn: () => api.skiSwap.taxonomy(orgId),
    staleTime: 5 * 60 * 1000,
  });

  const category = taxonomy?.categories.find((c) => c.id === value.categoryId);

  /**
   * The questions this form maps over: the category's own, and only those.
   *
   * A chosen value's questions are rendered by `AttributeField` itself, nested
   * under the answer that opened them. Listing them here as well would draw each
   * one twice — once indented, once at the top level.
   */
  const topLevel = category?.attributes ?? [];

  /**
   * Every attribute currently reachable, flattened.
   *
   * Not what gets rendered — what the name preview looks answers up in, which
   * has to include the nested ones because they carry name slots too.
   */
  const reachable = useMemo(() => {
    if (!category) return [] as ResolvedAttribute[];
    const out: ResolvedAttribute[] = [];
    const walk = (attributes: ResolvedAttribute[]) => {
      for (const a of attributes) {
        out.push(a);
        const picked = value.answers[a.id]?.valueId;
        if (!picked) continue;
        const v = (a.values ?? []).find((x) => x.id === picked);
        if (v) walk(v.attributes);
      }
    };
    walk(category.attributes);
    return out;
  }, [category, value.answers]);

  const attributesById = useMemo(() => new Map(reachable.map((a) => [a.id, a])), [reachable]);

  const labelIndex = useMemo(() => {
    const m = new Map(valueLabels);
    const walk = (attributes: ResolvedAttribute[]) => {
      for (const a of attributes) {
        for (const v of a.values ?? []) {
          m.set(v.id, v.label);
          walk(v.attributes);
        }
      }
    };
    if (category) walk(category.attributes);
    return m;
  }, [category, valueLabels]);

  const onValuesLoaded = useCallback((values: ResolvedValue[]) => {
    setValueLabels((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const v of values) {
        if (next.get(v.id) !== v.label) { next.set(v.id, v.label); changed = true; }
      }
      return changed ? next : prev;
    });
  }, []);

  const setAnswer = useCallback(
    (attributeId: string, next: DescriberAnswer) => {
      onChange({
        ...value,
        answers: { ...value.answers, [attributeId]: next },
      });
    },
    [onChange, value],
  );

  const pickCategory = (categoryId: string) => {
    // A different category asks different questions, so the answers go with it.
    onChange(categoryId === value.categoryId ? emptyDescriber : { categoryId, answers: {} });
    setExpanded(false);
  };

  const preview = previewName(value, category, attributesById, labelIndex);

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>;

  // A failed fetch is not an empty tree, and saying so sent people to configure
  // something that was already there — a seller was being refused this call,
  // and the form reported eighteen categories as none.
  if (error) {
    return (
      <p className="text-sm text-amber-400">
        The item list could not be loaded. {(error as Error)?.message ?? 'Try again.'}
      </p>
    );
  }

  if (!taxonomy || taxonomy.categories.length === 0) {
    return (
      <p className="text-sm text-amber-400">
        No item categories are set up yet. An administrator can add them under
        Administration → Item details.
      </p>
    );
  }

  // Category first, alone, full width. Nothing else renders until it is picked.
  if (!category) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium text-gray-300">What is it?</p>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {taxonomy.categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => pickCategory(c.id)}
              className="flex flex-col items-center justify-center gap-1.5 py-3 px-1 rounded-xl bg-surface-100 border border-gray-700 hover:bg-surface-200 hover:border-gray-600"
            >
              <NodeIcon icon={c.icon} className="h-6 w-6 text-brand-500" />
              <span className="text-xs text-gray-200 text-center leading-tight">{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // Counted over the top-level questions, so the number does not jump when
  // answering one opens a branch beneath it.
  const shown = layout === 'grid' || expanded ? topLevel : topLevel.slice(0, VISIBLE_ON_PHONE);
  const hidden = topLevel.length - shown.length;

  return (
    <div className="space-y-3">
      {/* Collapses to a header once picked, with the way back out beside it. */}
      <div className="flex items-center justify-between gap-2 pb-1 border-b border-gray-800">
        <span className="flex items-center gap-2 text-sm font-medium text-white">
          <NodeIcon icon={category.icon} className="h-4 w-4 text-brand-500" />
          {category.label}
        </span>
        <button
          type="button"
          onClick={() => onChange(emptyDescriber)}
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          Change
        </button>
      </div>

      {/* Said outright, because nothing else on the screen said it.
          Every answer here is optional (D6), and `canAdd` bears that out — a
          category and a price are the whole requirement. The count on "More
          detail" was the only hint, and it only ever spoke about the questions
          still hidden, never the ones a seller is looking at, so somebody who
          does not know a model year had no way to tell whether they were stuck.

          One idea, not two: the preview underneath already shows the name
          improving as answers go in, so saying that here as well would be
          explaining what the screen is busy demonstrating. */}
      {topLevel.length > 0 && (
        <p className="text-xs text-gray-500">
          Answer what you know — none of it is required.
        </p>
      )}

      <div className={layout === 'grid' ? 'grid grid-cols-2 gap-x-4 gap-y-3' : 'space-y-3'}>
        {shown.map((a) => (
          <AttributeField
            key={a.id}
            orgId={orgId}
            attribute={a}
            state={value}
            setAnswer={setAnswer}
            depth={0}
            onValuesLoaded={onValuesLoaded}
          />
        ))}
      </div>

      {/* The count is the honest signal that there is more, and that skipping it
          is allowed — nothing here is required (D6). */}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-sm text-brand-400 hover:text-brand-300 flex items-center gap-1.5"
        >
          <FontAwesomeIcon icon={faChevronDownDuo} />
          More detail ({hidden})
        </button>
      )}

      {renderPreview ? renderPreview(preview) : null}
    </div>
  );
}
