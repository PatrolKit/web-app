import type { ItemAttributeInput, ResolvedAttribute, ResolvedCategory, ResolvedTaxonomy, ResolvedValue } from '../../lib/api.types';

/**
 * The legacy ticket fast edit's logic (Plan 37), kept apart from the dialog so
 * it can be tested: reading a typed description against the taxonomy, what to
 * suggest while typing it, and what each key does.
 */

// ─── Reading a description (D2, D3) ──────────────────────────────────────────

/** What a description line stores: the item's category, its answers and its name. */
export interface ParsedDetails {
  /** Null when no category was named: then only the name changes. */
  categoryId: string | null;
  attributes: ItemAttributeInput[];
  name: string;
  /**
   * Words that matched nothing, in the order typed. With none, the name is
   * exactly the server's (`deriveName`), so the save leaves it to the server.
   */
  extra: string[];
}

interface Word {
  raw: string;
  norm: string;
}

/**
 * A word as it's compared: lower case, without surrounding punctuation, and
 * without a plural "s", so "skis" finds Skis and "jacket" finds Jackets.
 */
export function normWord(w: string): string {
  const bare = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return bare.length > 3 && bare.endsWith('s') && !bare.endsWith('ss') ? bare.slice(0, -1) : bare;
}

function wordsOf(text: string): Word[] {
  return (text.match(/\S+/g) ?? []).map((raw) => ({ raw, norm: normWord(raw) }));
}

function labelWords(label: string): string[] {
  return (label.match(/\S+/g) ?? []).map(normWord).filter(Boolean);
}

/** Whether `label` matches the words starting at `at`, whole words only. */
function matchesAt(words: Word[], at: number, label: string[]): boolean {
  if (label.length === 0 || at + label.length > words.length) return false;
  return label.every((l, i) => words[at + i].norm === l);
}

/** The category's answerable attributes, given the values chosen so far (nested questions included). */
function reachableAttributes(category: ResolvedCategory, chosen: Map<string, ResolvedValue>): ResolvedAttribute[] {
  const out: ResolvedAttribute[] = [];
  const walk = (attrs: ResolvedAttribute[]) => {
    for (const a of [...attrs].sort((x, y) => x.displayOrder - y.displayOrder)) {
      out.push(a);
      const v = chosen.get(a.id);
      if (v) walk(v.attributes);
    }
  };
  walk(category.attributes);
  return out;
}

/**
 * A typed description, read against the taxonomy (Plan 37 D2, D3).
 *
 * - The first category named sets the category; with none named, `impliedCategoryId`
 *   (a value picked from the suggestions before any category) does.
 * - Values match only that category's questions, longest label first, whole
 *   words, one answer per question. A value's own follow-up questions (a
 *   manufacturer's models) become answerable once it's matched.
 * - The name is composed as everywhere else (iOS, the single-item form, the
 *   server's `deriveName`): the named answers in slot order, then the
 *   category's label. An answer to a question with no name slot is stored,
 *   not named.
 * - Nothing is minted: words that matched nothing follow, as typed.
 *
 * Null for an empty line, which changes nothing (D4).
 */
export function parseDetails(
  text: string,
  taxonomy: ResolvedTaxonomy,
  impliedCategoryId: string | null = null,
): ParsedDetails | null {
  const words = wordsOf(text);
  if (words.length === 0) return null;
  const used: boolean[] = words.map(() => false);

  // The category: the first one named, longest label first at each word.
  const categories = [...taxonomy.categories]
    .map((c) => ({ c, label: labelWords(c.label) }))
    .sort((a, b) => b.label.length - a.label.length);
  let category: ResolvedCategory | null = null;
  for (let at = 0; at < words.length && !category; at++) {
    const hit = categories.find(({ label }) => matchesAt(words, at, label));
    if (hit) {
      category = hit.c;
      claim(at, hit.label.length);
    }
  }
  const implied = !category && impliedCategoryId
    ? taxonomy.categories.find((c) => c.id === impliedCategoryId) ?? null
    : null;
  category ??= implied;

  // No category, no structure: the line is the name.
  if (!category) return { categoryId: null, attributes: [], name: words.map((w) => w.raw).join(' '), extra: [] };

  // Values, in passes, so a model named before its manufacturer still matches
  // once the manufacturer has opened its question.
  const chosen = new Map<string, ResolvedValue>();
  const askedBy = new Map<string, ResolvedAttribute>();
  for (let changed = true; changed;) {
    changed = false;
    const open = reachableAttributes(category, chosen).filter((a) => a.input === 'select' && !chosen.has(a.id) && a.values?.length);
    const candidates = open
      .flatMap((a) => a.values!.map((v) => ({ a, v, label: labelWords(v.label) })))
      .filter((x) => x.label.length > 0)
      .sort((x, y) => y.label.length - x.label.length);
    for (let at = 0; at < words.length && !changed; at++) {
      if (used[at]) continue;
      const hit = candidates.find((x) => !x.label.some((_, i) => used[at + i]) && matchesAt(words, at, x.label));
      if (hit) {
        chosen.set(hit.a.id, hit.v);
        askedBy.set(hit.a.id, hit.a);
        claim(at, hit.label.length);
        changed = true;
      }
    }
  }

  // Ordered as `deriveName` orders them: slot, then display order, then label.
  const named = [...chosen]
    .map(([attributeId, v]) => ({ a: askedBy.get(attributeId)!, v }))
    .filter(({ a }) => a.nameSlot !== null)
    .sort((x, y) =>
      (x.a.nameSlot ?? 0) - (y.a.nameSlot ?? 0) || x.a.displayOrder - y.a.displayOrder || x.a.label.localeCompare(y.a.label))
    .map(({ v }) => v.label);
  const extra = words.filter((_, i) => !used[i]).map((w) => w.raw);

  return {
    categoryId: category.id,
    attributes: [...chosen].map(([attributeId, v]) => ({ attributeId, valueId: v.id })),
    name: [...named, category.label, ...extra].join(' ').replace(/\s+/g, ' ').trim(),
    extra,
  };

  function claim(at: number, length: number) {
    for (let i = 0; i < length; i++) used[at + i] = true;
  }
}

// ─── Suggestions while typing ────────────────────────────────────────────────

export interface DetailsSuggestion {
  key: string;
  label: string;
  /** What it is: "Type", or "Skis · Manufacturer". */
  sublabel: string;
  /** Set when picking it brings a category with it. */
  categoryId: string;
  kind: 'category' | 'value';
}

/** The word the cursor is in: where it starts, and what's typed of it. */
export function currentWord(text: string, cursor: number): { start: number; typed: string } {
  let start = cursor;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  return { start, typed: text.slice(start, cursor) };
}

function startsWithTyped(label: string, typed: string): boolean {
  const t = typed.toLowerCase();
  return label.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)) || label.toLowerCase().startsWith(t);
}

/**
 * What to offer for the word being typed (Plan 37).
 *
 * Before a category is known: categories first, then any category's values,
 * each saying which category and question it answers. After: that category's
 * values for questions not yet answered.
 */
export function detailsSuggestions(
  text: string,
  cursor: number,
  taxonomy: ResolvedTaxonomy,
  impliedCategoryId: string | null,
  limit = 8,
): DetailsSuggestion[] {
  const { typed } = currentWord(text, cursor);
  if (!typed.trim()) return [];
  // Read without the word being typed, so a half-typed word doesn't count.
  const before = text.slice(0, cursor - typed.length) + text.slice(cursor);
  const parsed = parseDetails(before, taxonomy, impliedCategoryId);
  // A picked value's category counts even before anything else is typed.
  const categoryId = parsed?.categoryId ?? impliedCategoryId;
  const category = categoryId ? taxonomy.categories.find((c) => c.id === categoryId) ?? null : null;

  const out: DetailsSuggestion[] = [];
  const seen = new Set<string>();
  const add = (s: DetailsSuggestion) => {
    if (out.length >= limit || seen.has(s.key)) return;
    seen.add(s.key);
    out.push(s);
  };

  if (!category) {
    for (const c of taxonomy.categories) {
      if (startsWithTyped(c.label, typed)) add({ key: `c:${c.id}`, label: c.label, sublabel: 'Type', categoryId: c.id, kind: 'category' });
    }
    for (const c of taxonomy.categories) {
      for (const { a, v } of allValues(c.attributes)) {
        if (startsWithTyped(v.label, typed)) {
          add({ key: `v:${c.id}:${v.id}`, label: v.label, sublabel: `${c.label} · ${a.label}`, categoryId: c.id, kind: 'value' });
        }
      }
    }
    return out;
  }

  const answers = parsed?.attributes ?? [];
  const answered = new Set(answers.map((x) => x.attributeId));
  const chosen = new Map<string, ResolvedValue>();
  for (const { a, v } of allValues(category.attributes)) {
    if (answers.some((x) => x.attributeId === a.id && x.valueId === v.id)) chosen.set(a.id, v);
  }
  for (const a of reachableAttributes(category, chosen)) {
    if (answered.has(a.id) || a.input !== 'select') continue;
    for (const v of a.values ?? []) {
      if (startsWithTyped(v.label, typed)) {
        add({ key: `v:${category.id}:${v.id}`, label: v.label, sublabel: a.label, categoryId: category.id, kind: 'value' });
      }
    }
  }
  return out;
}

/** Every select value under these questions, follow-ups included. */
function allValues(attrs: ResolvedAttribute[]): { a: ResolvedAttribute; v: ResolvedValue }[] {
  const out: { a: ResolvedAttribute; v: ResolvedValue }[] = [];
  for (const a of attrs) {
    if (a.input !== 'select') continue;
    for (const v of a.values ?? []) {
      out.push({ a, v });
      out.push(...allValues(v.attributes));
    }
  }
  return out;
}

/** The line with the word at the cursor replaced by a picked suggestion, and where the cursor goes. */
export function acceptSuggestion(text: string, cursor: number, label: string): { text: string; cursor: number } {
  const { start } = currentWord(text, cursor);
  let end = cursor;
  while (end < text.length && !/\s/.test(text[end])) end++;
  const head = text.slice(0, start) + label + ' ';
  const tail = text.slice(end).replace(/^\s+/, '');
  return { text: head + tail, cursor: head.length };
}

// ─── Keys (D5) ───────────────────────────────────────────────────────────────

export type Field = 'sku' | 'details' | 'price';

export interface KeyContext {
  field: Field;
  key: string;
  shift: boolean;
  /** Suggestions showing under the focused field. */
  suggestionsOpen: boolean;
  /** The highlighted suggestion, or -1. */
  highlighted: number;
  /** Whether the highlight was moved with the arrow keys, rather than sitting on the first by default. */
  arrowed: boolean;
  /** SKU: what's typed is exactly an unpriced ticket's. */
  skuExact: boolean;
  /** Whether a ticket is loaded. */
  loaded: boolean;
  /** Price: a positive amount is typed. */
  priceValid: boolean;
  /** Nothing typed in any field and no ticket loaded. */
  empty: boolean;
}

export type KeyAction =
  | { do: 'none' }
  /** Let the browser have it: typing, moving the cursor. */
  | { do: 'default' }
  | { do: 'highlight'; by: 1 | -1 }
  | { do: 'loadExact'; then: 'details' }
  | { do: 'loadHighlighted'; then: 'details' }
  /** The SKU isn't one that can be loaded: say why, and stay. */
  | { do: 'refuseSku' }
  | { do: 'accept'; then: 'stay' | 'price' }
  | { do: 'focus'; field: Field }
  | { do: 'save' }
  | { do: 'needPrice' }
  | { do: 'closeSuggestions' }
  | { do: 'clearTicket' }
  | { do: 'exit' };

/** What a key does in the fast edit (Plan 37 D5). */
export function fastEditKey(c: KeyContext): KeyAction {
  const { field, key, shift } = c;

  if (key === 'Escape') {
    if (c.suggestionsOpen) return { do: 'closeSuggestions' };
    return c.empty ? { do: 'exit' } : { do: 'clearTicket' };
  }
  if ((key === 'ArrowDown' || key === 'ArrowUp') && c.suggestionsOpen) {
    return { do: 'highlight', by: key === 'ArrowDown' ? 1 : -1 };
  }
  if (key === 'Tab' && shift) {
    if (field === 'details') return { do: 'focus', field: 'sku' };
    if (field === 'price') return { do: 'focus', field: 'details' };
    return { do: 'none' };
  }

  if (field === 'sku' && (key === 'Enter' || key === 'Tab')) {
    // A suggestion only when picked with the arrows: a partial number never
    // loads its first suggestion by accident.
    if (c.suggestionsOpen && c.arrowed && c.highlighted >= 0) return { do: 'loadHighlighted', then: 'details' };
    if (c.skuExact) return { do: 'loadExact', then: 'details' };
    if (c.loaded) return { do: 'focus', field: 'details' };
    return { do: 'refuseSku' };
  }

  if (field === 'details') {
    if (key === 'Enter') {
      if (c.suggestionsOpen && c.highlighted >= 0) return { do: 'accept', then: 'stay' };
      return { do: 'focus', field: 'price' };
    }
    if (key === 'Tab') {
      if (c.suggestionsOpen && c.arrowed && c.highlighted >= 0) return { do: 'accept', then: 'price' };
      return { do: 'focus', field: 'price' };
    }
  }

  if (field === 'price') {
    if (key === 'Enter') {
      if (!c.loaded) return { do: 'focus', field: 'sku' };
      return c.priceValid ? { do: 'save' } : { do: 'needPrice' };
    }
    // Saving is Enter's; Tab goes nowhere rather than out of the form.
    if (key === 'Tab') return { do: 'none' };
  }

  return { do: 'default' };
}

// ─── Saying what will be stored ──────────────────────────────────────────────

/** "Skis · Manufacturer Rossignol · Color Red": a parsed line as it will be stored. */
export function describeParsed(parsed: ParsedDetails, taxonomy: ResolvedTaxonomy): string {
  const category = taxonomy.categories.find((c) => c.id === parsed.categoryId);
  if (!category) return 'No type: the name only';
  const all = allValues(category.attributes);
  const answers = parsed.attributes.map((x) => {
    const hit = all.find(({ a, v }) => a.id === x.attributeId && v.id === x.valueId);
    return hit ? `${hit.a.label} ${hit.v.label}` : null;
  });
  return [category.label, ...answers.filter(Boolean)].join(' · ');
}
