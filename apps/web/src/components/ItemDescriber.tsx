import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faChevronDown as faChevronDownDuo,
  faChevronRight as faChevronRightDuo,
  faCircleInfo as faCircleInfoDuo,
  faPlus as faPlusDuo,
  faTag as faTagDuo,
  faXmark as faXmarkDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../lib/api';
import { taxonomyIcon } from '../lib/taxonomyIcons';
import SearchableSelect from './SearchableSelect';
import { composeName, type NamePart } from '@patrolkit/contracts/item-name';
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

// ─── The name preview ────────────────────────────────────────────────────────

/**
 * What the item will be called, composed the way the server will compose it.
 *
 * A local copy of `deriveName` rather than a round trip per keystroke. The server
 * still composes the real one on save — this is the feedback loop that shows a
 * seller their listing improving as they answer, and being a keystroke behind
 * the truth would cost nothing but being a request behind it would.
 */
/**
 * What one answer reads as: a chosen label, something typed, or a number and
 * its unit. Empty when the question is unanswered.
 *
 * Shared by the name preview and the accordion rows, because a row saying one
 * thing while the tag says another is the kind of disagreement nobody reports
 * and everybody distrusts.
 */
export function answerText(
  attribute: ResolvedAttribute,
  answer: DescriberAnswer,
  valueLabelById: Map<string, string>,
): string {
  if (answer.valueId) return valueLabelById.get(answer.valueId) ?? '';
  if (answer.freeText?.trim()) return answer.freeText.trim();
  if (answer.numberValue !== undefined && answer.numberValue.trim() !== '') {
    const n = Number(answer.numberValue);
    if (!Number.isFinite(n)) return '';
    const digits = Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
    return `${digits}${attribute.unit ?? ''}`;
  }
  return '';
}

/**
 * The answered questions the name is made of, in the order it uses them.
 *
 * Split out from `previewName` because the screen says where the name came
 * from, not just what it is, and counting the parts is the honest way to say
 * "built from three of your answers" rather than asserting it.
 */
export function nameParts(
  state: DescriberState,
  category: ResolvedCategory | undefined,
  attributesById: Map<string, ResolvedAttribute>,
  valueLabelById: Map<string, string>,
): NamePart[] {
  if (!category) return [];
  return Object.entries(state.answers)
    .map(([attributeId, answer]) => ({ attribute: attributesById.get(attributeId), answer }))
    .filter((x): x is { attribute: ResolvedAttribute; answer: DescriberAnswer } => !!x.attribute)
    .filter((x) => x.attribute.nameSlot !== null)
    .sort((a, b) => (a.attribute.nameSlot ?? 0) - (b.attribute.nameSlot ?? 0) || a.attribute.displayOrder - b.attribute.displayOrder)
    .map(({ attribute, answer }) => ({ text: answerText(attribute, answer, valueLabelById), freeEntry: !!attribute.allowFreeEntry }))
    .filter((p) => p.text !== '');
}

export function previewName(
  state: DescriberState,
  category: ResolvedCategory | undefined,
  attributesById: Map<string, ResolvedAttribute>,
  valueLabelById: Map<string, string>,
): string {
  if (!category) return '';
  return composeName(nameParts(state, category, attributesById, valueLabelById), category.label);
}

/**
 * The name, and where it came from.
 *
 * It used to be the bare string in a bordered box — the same border, fill and
 * text size as the price field under it and the notes field under that. So it
 * read as a name you were expected to type and had not, which is the one thing
 * it is not: it is assembled from the answers above and there is no way to edit
 * it here. Saying so costs a line of grey text, and a dashed border to keep it
 * from looking like somewhere to put a cursor.
 */
export function NamePreview({ name, parts }: { name: string; parts: number }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-700 bg-surface-200 px-3 py-2.5 space-y-1">
      <p className="flex items-center gap-1.5 text-xs text-gray-500">
        <FontAwesomeIcon icon={faTagDuo} className="h-3 w-3" />
        Its tag will read — built from your answers
      </p>
      <p className="text-sm font-medium text-white">{name}</p>
      {parts === 0 && (
        <p className="text-xs text-gray-500">
          Answer a question above and the name gets more specific.
        </p>
      )}
    </div>
  );
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

/**
 * Diacritics folded away, so typing what is on the keyboard finds what is on the
 * topsheet. Half the makes a seller looks for are spelled Völkl, Stöckli or
 * Kästle, and none of them are reachable from a phone without this.
 */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * The legal answers to a number question, when there are few enough to tap.
 *
 * `min`, `max` and `step` already describe a finite set — the server rejects
 * anything off the step with "goes in steps of 5" — so a bounded question with a
 * coarse step is a closed list wearing a text field. Only a short one: a ski
 * length is 70–215 in steps of 1, and 146 chips is not a control.
 */
/**
 * How many chips will sit in a row's body before it is a list rather than a
 * choice. Fourteen colors are five short lines and read at a glance; the
 * thirty-seven makes never did.
 *
 * Not the old `> 8`, which was drawn for a dropdown: eight was where scrolling a
 * native select got annoying, and it sent Color — a question whose whole point
 * is that you recognise the answer — off to a screen of its own.
 */
const MAX_INLINE_CHIPS = 16;

/**
 * Whether a question is too long to answer in place.
 *
 * Decided from the attribute alone, never from the values, because the row that
 * has to draw the trigger renders before a deferred branch has loaded — and a
 * branch is only ever deferred because it is long.
 */
export function usesSheet(attribute: ResolvedAttribute): boolean {
  if (attribute.input !== 'select') return false;
  // Free entry alone does not earn a sheet: a short list keeps its chips and
  // gains one more that opens the sheet to type in.
  return (
    attribute.valuesDeferred === true ||
    (attribute.values?.length ?? 0) > MAX_INLINE_CHIPS
  );
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
 * A long list, answered on a screen of its own.
 *
 * Thirty-seven makes have never fitted inside a card, and the dropdown that used
 * to hold them came with a text field and a "+" beside it — three affordances
 * for one answer. A sheet has room to be one: search narrows, chips answer, and
 * something the list has never heard of is another chip rather than another
 * control.
 */
function ValueSheet({
  attribute, values, answer, onPick, onClose,
}: {
  attribute: ResolvedAttribute;
  values: ResolvedValue[];
  answer: DescriberAnswer;
  onPick: (next: DescriberAnswer) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = fold(query.trim());

  const hits = useMemo(
    () => (needle ? values.filter((v) => fold(v.label).includes(needle)) : values),
    [values, needle],
  );
  // Only offer to mint what the list does not already hold, or two chips would
  // answer the same question differently — one a value, one a pending duplicate.
  const canAdd =
    attribute.allowFreeEntry === true &&
    query.trim() !== '' &&
    !values.some((v) => fold(v.label) === needle);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end bg-black/60"
      onClick={onClose}
    >
      <div
        className="bg-surface-50 border-t border-gray-700 rounded-t-2xl flex flex-col max-h-[85vh] p-4"
        style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={attribute.label}
      >
        <div className="flex items-center justify-between gap-3 pb-3">
          <span className="flex items-center gap-1.5 text-sm font-medium text-white">
            <NodeIcon icon={attribute.icon} className="h-4 w-4" />
            {attribute.label}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-white text-sm flex items-center gap-1.5"
          >
            <FontAwesomeIcon icon={faXmarkDuo} className="h-3.5 w-3.5" />
            Cancel
          </button>
        </div>

        {/* Not autofocused. The sheet opens on a tap that meant "show me the
            list", and focusing the box answers with a keyboard over the top of
            it — three quarters of the makes hidden behind the thing you would
            only need if none of them fitted. Search is for the seller who looks
            and does not see theirs. 16px like the rest of check-in, so that when
            they do tap it iOS does not zoom (see `inputClass`). */}
        <input
          className="bg-surface-100 border border-gray-700 rounded-lg px-3 py-2.5 text-base text-white placeholder:text-gray-500 focus:border-brand-600 focus:outline-none"
          placeholder={
            attribute.allowFreeEntry
              ? `Search ${values.length}, or type a new one`
              : `Search ${values.length}`
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="flex flex-wrap gap-1.5 overflow-y-auto pt-3 -mx-1 px-1">
          {canAdd && (
            <button
              type="button"
              onClick={() => onPick({ freeText: query.trim() })}
              className="px-2.5 py-1.5 rounded-lg text-sm border border-dashed border-gray-600 text-gray-300 bg-surface-100 hover:bg-surface-200 flex items-center gap-1.5"
            >
              <FontAwesomeIcon icon={faPlusDuo} className="h-3 w-3" />
              Use “{query.trim()}”
            </button>
          )}
          {hits.map((v) => {
            const on = answer.valueId === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => onPick(on ? {} : { valueId: v.id })}
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
          {hits.length === 0 && !canAdd && (
            <p className="text-xs text-gray-500 py-2">
              {attribute.allowFreeEntry
                ? 'Nothing matches. Type it and use what you typed.'
                : 'Nothing matches.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A long, closed list, at the desk: a dropdown that searches, where a pointer
 * and a keyboard make it the faster control.
 */
function ValueSelect({
  attribute, values, answer, onChange,
}: {
  attribute: ResolvedAttribute;
  values: ResolvedValue[];
  answer: DescriberAnswer;
  onChange: (next: DescriberAnswer) => void;
}) {
  const options = useMemo(
    () => values.map((v) => ({ value: v.id, label: v.label })),
    [values],
  );
  return (
    <SearchableSelect
      value={answer.valueId ?? ''}
      onChange={(valueId) => onChange(valueId ? { valueId } : {})}
      options={options}
      placeholder={`Choose ${attribute.label.toLowerCase()}…`}
      clearLabel="Not sure"
    />
  );
}

type ComboRow = { kind: 'value'; value: ResolvedValue } | { kind: 'new'; text: string };

/**
 * A question that takes typed answers, at the desk: one box. Typing suggests
 * what's listed; pick one, or keep what you typed and it's added as new for
 * the patrol to approve. It used to be a dropdown, a second box and a "+",
 * which for a list with nothing on it yet ("What is it?" in Other) was a
 * dropdown offering "Not sure" and "No matches" beside the box that worked.
 *
 * Enter takes the highlighted row; leaving the box keeps what was typed. Typed
 * text that is a listed value, in any case, is that value, not a new one.
 */
function ValueCombo({
  attribute, values, answer, onChange,
}: {
  attribute: ResolvedAttribute;
  values: ResolvedValue[];
  answer: DescriberAnswer;
  onChange: (next: DescriberAnswer) => void;
}) {
  const chosen = answer.valueId ? values.find((v) => v.id === answer.valueId) : undefined;
  const newLabel = answer.freeText?.trim() ?? '';
  const answerLabel = chosen?.label ?? newLabel;

  /** What's typed, while typing; otherwise the box shows the answer. */
  const [typed, setTyped] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const text = typed ?? answerLabel;
  const needle = fold(text.trim());

  const rows = useMemo((): ComboRow[] => {
    // Only what's typed narrows; the answer sitting in the box doesn't.
    const searching = typed !== null && needle !== '';
    const hits = (searching ? values.filter((v) => fold(v.label).includes(needle)) : values).slice(0, 100);
    const listed = values.some((v) => fold(v.label) === needle);
    return [
      ...hits.map((value) => ({ kind: 'value' as const, value })),
      ...(searching && !listed ? [{ kind: 'new' as const, text: text.trim() }] : []),
    ];
  }, [values, typed, needle, text]);

  function settle(row?: ComboRow) {
    const t = text.trim();
    const listed = values.find((v) => fold(v.label) === fold(t));
    if (row?.kind === 'value') onChange({ valueId: row.value.id });
    else if (typed === null) { /* nothing typed: the answer stands */ }
    else if (!t) onChange({});
    else if (listed) onChange({ valueId: listed.id });
    else onChange({ freeText: t });
    setTyped(null);
    setOpen(false);
  }

  return (
    <div className="relative">
      <input
        className="w-full bg-surface-100 border border-gray-700 rounded-lg pl-2.5 pr-16 py-2 text-sm text-white placeholder:text-gray-500 focus:border-brand-600 focus:outline-none"
        placeholder={values.length ? 'Pick one, or type a new one' : 'Type it'}
        aria-label={attribute.label}
        role="combobox"
        aria-expanded={open && rows.length > 0}
        value={text}
        onFocus={() => setOpen(true)}
        onBlur={() => settle()}
        onChange={(e) => { setTyped(e.target.value); setHighlight(0); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, rows.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === 'Enter') {
            e.preventDefault();
            settle(open && typed !== null ? rows[highlight] : undefined);
          } else if (e.key === 'Escape' && open) { e.stopPropagation(); setTyped(null); setOpen(false); }
        }}
      />
      <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
        {typed === null && !chosen && newLabel && (
          <span className="text-[10px] uppercase tracking-wide text-amber-400">New</span>
        )}
        {typed === null && answerLabel && (
          <button
            type="button"
            aria-label={`Clear ${attribute.label}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { onChange({}); setTyped(null); }}
            className="text-gray-500 hover:text-gray-200 text-sm px-1"
          >×</button>
        )}
      </span>
      {open && rows.length > 0 && (
        <ul role="listbox" className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-surface-200 border border-gray-700 rounded shadow-lg py-1 text-sm">
          {rows.map((row, i) => (
            <li
              key={row.kind === 'value' ? row.value.id : 'new'}
              role="option"
              aria-selected={row.kind === 'value' && row.value.id === answer.valueId}
              onMouseEnter={() => setHighlight(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => settle(row)}
              className={`px-3 py-1.5 cursor-pointer ${highlight === i ? 'bg-surface-100' : ''} ${
                row.kind === 'new' ? 'text-amber-300' : row.value.id === answer.valueId ? 'text-brand-400' : 'text-white'
              }`}
            >
              {row.kind === 'value' ? row.value.label : `Add “${row.text}” as new`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One question as a row: its name, its answer, and the control folded away.
 *
 * Seven questions laid out as seven open fields is a form, and a form reads as
 * something to complete. Collapsed, the same seven fit above the fold, an
 * unanswered row is visibly blank rather than pointedly empty, and what is
 * already answered can be read back without scrolling past the controls that
 * set it.
 */
function AccordionRow({
  attribute, summary, open, onToggle, children, sheet = false,
}: {
  attribute: ResolvedAttribute;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** This one leaves for a screen of its own, so it points the way rather than down. */
  sheet?: boolean;
}) {
  return (
    <div className="border-b border-gray-800 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 py-2.5 text-left"
      >
        <span className="flex items-center gap-1.5 text-sm text-gray-300">
          <NodeIcon icon={attribute.icon} className="h-3.5 w-3.5" />
          {attribute.label}
        </span>
        <span className="flex items-center gap-2 min-w-0">
          <span className={`text-sm truncate ${summary ? 'text-white' : 'text-gray-600'}`}>
            {summary || '—'}
          </span>
          <FontAwesomeIcon
            icon={sheet ? faChevronRightDuo : faChevronDownDuo}
            className={`h-3 w-3 shrink-0 text-gray-500 transition-transform ${
              !sheet && open ? 'rotate-180' : ''
            }`}
          />
        </span>
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}

/** One question, and whatever its answer opens up beneath it. */
function AttributeField({
  orgId, attribute, state, setAnswer, depth, onValuesLoaded, hideLabel = false,
  chips = false, sheetOpen, onSheetOpenChange,
}: {
  orgId: string;
  attribute: ResolvedAttribute;
  state: DescriberState;
  setAnswer: (attributeId: string, next: DescriberAnswer) => void;
  depth: number;
  onValuesLoaded: (values: ResolvedValue[]) => void;
  /** The accordion row above already names the question; two labels is one too many. */
  hideLabel?: boolean;
  /** One control everywhere: chips in place, a sheet for the lists too long to sit in one. */
  chips?: boolean;
  /**
   * Whether the sheet is showing, when someone above needs to say so.
   *
   * A top-level question is opened by its row, and the row has to be able to
   * open it again — mounting with the sheet up would only work the first time,
   * because tapping an already-open row changes nothing to re-mount. A nested
   * question has no row above it, so it keeps its own state.
   */
  sheetOpen?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
}) {
  const answer = state.answers[attribute.id] ?? {};
  const [ownSheetOpen, setOwnSheetOpen] = useState(false);
  const showSheet = sheetOpen ?? ownSheetOpen;
  const setSheetOpen = useCallback(
    (open: boolean) => (onSheetOpenChange ? onSheetOpenChange(open) : setOwnSheetOpen(open)),
    [onSheetOpenChange],
  );

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
  // A value typed but not yet minted reads back the same as one that was listed.
  const pendingLabel = answer.freeText?.trim();
  const chosenLabel = chosen?.label ?? pendingLabel ?? '';
  const pendingNote = pendingLabel ? (
    <p className="text-xs text-amber-400">
      “{pendingLabel}” is new — it will be added for your patrol to approve.
    </p>
  ) : null;

  return (
    <div className={depth > 0 ? 'pl-3 border-l border-gray-800 space-y-1.5' : 'space-y-1.5'}>
      {!hideLabel && (
        <label className="flex items-center gap-1.5 text-xs font-medium text-gray-400">
          <NodeIcon icon={attribute.icon} className="h-3.5 w-3.5" />
          {attribute.label}
          {attribute.unit ? <span className="text-gray-600">({attribute.unit})</span> : null}
        </label>
      )}

      {/* Every number is typed.
          
          Chips were offered where the legal set was short enough to lay out
          flat, which after the ranged experiment was reverted left exactly one
          attribute in the whole tree wearing them — a 70 to 140 length in
          fives, fifteen values — while ski length, waist width, mondopoint and
          the rest were fields. One question behaving unlike its nine siblings
          is worse than any of the arrangements, so the threshold is gone. */}
      {attribute.input === 'number' ? (
        <div className="flex items-center gap-2">
          <input
            className="w-28 bg-surface-100 border border-gray-700 rounded-lg px-2.5 py-2 text-base text-white placeholder:text-gray-500 focus:border-brand-600 focus:outline-none"
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
      ) : chips && usesSheet(attribute) ? (
        <>
          {/* One button, and the answer on it. The sheet behind it is where the
              search, the list and the free entry all live now. */}
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="w-full flex items-center justify-between gap-2 bg-surface-100 border border-gray-700 rounded-lg px-3 py-2 text-sm text-left hover:bg-surface-200"
          >
            <span className={chosenLabel ? 'text-white' : 'text-gray-500'}>
              {chosenLabel || `Choose ${attribute.label.toLowerCase()}…`}
            </span>
            <FontAwesomeIcon icon={faChevronRightDuo} className="h-3 w-3 shrink-0 text-gray-500" />
          </button>
          {pendingNote}
          {showSheet && (
            <ValueSheet
              attribute={attribute}
              values={values}
              answer={answer}
              onPick={(next) => { setAnswer(attribute.id, next); setSheetOpen(false); }}
              onClose={() => setSheetOpen(false)}
            />
          )}
        </>
      ) : chips ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            <ValueChips
              values={values}
              selected={answer.valueId}
              onPick={(valueId) => setAnswer(attribute.id, valueId ? { valueId } : {})}
            />
            {attribute.allowFreeEntry && (
              <button
                type="button"
                onClick={() => setSheetOpen(true)}
                className={`px-2.5 py-1.5 rounded-lg text-sm border border-dashed flex items-center gap-1.5 ${
                  answer.freeText?.trim()
                    ? 'bg-brand-600 border-brand-600 text-white'
                    : 'border-gray-600 text-gray-300 bg-surface-100 hover:bg-surface-200'
                }`}
              >
                <FontAwesomeIcon icon={faPlusDuo} className="h-3 w-3" />
                {answer.freeText?.trim() || (values.length ? 'Something else' : 'Type it')}
              </button>
            )}
          </div>
          {pendingNote}
          {showSheet && (
            <ValueSheet
              attribute={attribute}
              values={values}
              answer={answer}
              onPick={(next) => { setAnswer(attribute.id, next); setSheetOpen(false); }}
              onClose={() => setSheetOpen(false)}
            />
          )}
        </>
      ) : attribute.allowFreeEntry ? (
        <>
          <ValueCombo
            attribute={attribute}
            values={values}
            answer={answer}
            onChange={(next) => setAnswer(attribute.id, next)}
          />
          {pendingNote}
        </>
      ) : values.length > 8 ? (
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
          chips={chips}
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
  renderPreview?: (name: string, detail: { parts: number }) => React.ReactNode;
}

export default function ItemDescriber({
  orgId, value, onChange, layout = 'stacked', renderPreview,
}: ItemDescriberProps) {
  /**
   * Which question is open. One at a time — two open rows is the stack of
   * fields this replaced.
   */
  const [openId, setOpenId] = useState<string | null>(null);
  /** Which question has taken the screen, if any. See `AttributeField`'s props. */
  const [sheetId, setSheetId] = useState<string | null>(null);
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

      // Picking closes the row — unless the answer asked another question. A
      // manufacturer opens a model list, and collapsing on top of it would hide
      // the thing the tap just produced. Typed numbers never close: every
      // keystroke is a change, and the row would shut on the first digit.
      if (!next.valueId) return;
      const attribute = topLevel.find((a) => a.id === attributeId);
      if (!attribute) return;
      const picked = (attribute.values ?? []).find((v) => v.id === next.valueId);
      if (!picked || picked.attributes.length === 0) setOpenId(null);
    },
    [onChange, value, topLevel],
  );

  const pickCategory = (categoryId: string) => {
    // A different category asks different questions, so the answers go with it.
    onChange(categoryId === value.categoryId ? emptyDescriber : { categoryId, answers: {} });
    setOpenId(null);
    setSheetId(null);
  };

  const parts = nameParts(value, category, attributesById, labelIndex);
  const preview = category ? composeName(parts, category.label) : '';

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
      {topLevel.length > 0 &&
        /* Two treatments, because two readers.
           
           `stacked` is self check-in: a member of the public, on their own
           phone, part way through describing a pair of skis and wondering
           whether they are allowed to stop. They get a box — bordered and set
           apart, so it reads as the screen speaking rather than as a caption on
           the question below it, which is what a loose line of grey looked
           like next to a column of fields.
           
           Staff at the desk have read this sentence a hundred times by
           mid-morning. A box there would take room from a dense form to say
           something nobody there is still wondering, so it stays a line. */
        (layout === 'stacked' ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-gray-700/70 bg-surface-100/50 px-3 py-2.5">
            <FontAwesomeIcon
              icon={faCircleInfoDuo}
              // Not amber, not red. Nothing is wrong and nothing needs doing —
              // this is permission to move on, and a warning color would say
              // the opposite of the sentence beside it.
              className="mt-0.5 h-4 w-4 shrink-0 text-gray-500"
            />
            <p className="text-sm text-gray-400">
              Answer what you know —{' '}
              <strong className="font-semibold text-gray-200">none of it is required</strong>.
            </p>
          </div>
        ) : (
          <p className="text-xs text-gray-500">
            Answer what you know —{' '}
            {/* Weighted and lifted out of the grey, because this is the half of
                the sentence someone skims for when they do not know a model
                year and are wondering whether they are stuck. */}
            <strong className="font-semibold text-gray-300">none of it is required</strong>.
          </p>
        ))}

      {/* Two densities of the same form, as before. The desk has room to show
          every question at once and staff enter items all day, so nothing there
          is worth a tap to open. A phone does not, and did not: four questions
          fitted and the other three sat behind "More detail", which is a worse
          version of a row you can open. */}
      {layout === 'grid' ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {topLevel.map((a) => (
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
      ) : (
        <div>
          {topLevel.map((a) => (
            <AccordionRow
              key={a.id}
              attribute={a}
              summary={answerText(a, value.answers[a.id] ?? {}, labelIndex)}
              open={openId === a.id}
              // A question with a sheet behind it has nothing worth showing in a
              // row, so opening the row opens the sheet, every time it is tapped
              // rather than only the first — the row is a label and a chevron,
              // and tapping it can only mean "let me answer this".
              sheet={usesSheet(a)}
              onToggle={() => {
                if (usesSheet(a)) { setOpenId(a.id); setSheetId(a.id); return; }
                setSheetId(null);
                setOpenId(openId === a.id ? null : a.id);
              }}
            >
              <AttributeField
                orgId={orgId}
                attribute={a}
                state={value}
                setAnswer={setAnswer}
                depth={0}
                onValuesLoaded={onValuesLoaded}
                hideLabel
                chips
                {...(usesSheet(a)
                  ? {
                      sheetOpen: sheetId === a.id,
                      onSheetOpenChange: (open: boolean) => setSheetId(open ? a.id : null),
                    }
                  : {})}
              />
            </AccordionRow>
          ))}
        </div>
      )}

      {renderPreview ? renderPreview(preview, { parts: parts.length }) : null}
    </div>
  );
}
