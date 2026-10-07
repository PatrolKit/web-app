import type { BindingLookup, IndemnificationAnswer } from '../../lib/api.types';

/**
 * The Bindings tab's pure parts (Plan 44): how an answer reads, and the
 * client-side narrowing of a brand's list that mirrors the server's search.
 */

export interface AnswerBadge {
  label: string;
  /** Tailwind classes for the badge. */
  className: string;
  /** One line under the model: "Listed 2025-26, retail and rental". */
  line: string;
}

const seasonText = (s: string | null) => (s ? s : '');

function linesText(lines: BindingLookup['lines']): string {
  if (lines.length === 0) return '';
  if (lines.length === 1) return lines[0];
  return `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}`;
}

export function answerBadge(l: Pick<BindingLookup, 'answer' | 'season' | 'lastListedSeason' | 'lines' | 'currentLine'>): AnswerBadge {
  const where = linesText(l.lines);
  const current = l.currentLine === null ? '' : l.currentLine ? ', current line' : ', older model';
  switch (l.answer) {
    case 'indemnified':
      return {
        label: 'Indemnified',
        className: 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
        line: `Listed ${seasonText(l.season)}${where ? `, ${where}` : ''}${current}`,
      };
    case 'final_season':
      return {
        label: 'Final season',
        className: 'bg-amber-900/60 text-amber-300 border-amber-700',
        line: `Indemnified through ${seasonText(l.season)}${where ? `, ${where}` : ''}; not after`,
      };
    case 'lapsed':
      return {
        label: 'Lapsed',
        className: 'bg-amber-900/60 text-amber-300 border-amber-700',
        line: `Last listed ${seasonText(l.lastListedSeason)}; not on the ${seasonText(l.season)} list`,
      };
    case 'not_listed':
      return {
        label: 'Not on the list',
        className: 'bg-surface-200 text-gray-300 border-gray-700',
        line: 'Not on any indemnified list we hold',
      };
    case 'unavailable':
      return {
        label: 'Unavailable',
        className: 'bg-slate-800 text-slate-300 border-slate-600',
        line: 'On a list your patrol hasn’t declared access to',
      };
  }
}

export const ANSWER_ORDER: IndemnificationAnswer[] = ['indemnified', 'final_season', 'lapsed', 'not_listed', 'unavailable'];

/** Spelling, not meaning, as the server normalises: case, accents, superscripts, punctuation. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Every query token starts some token of "maker model", as the server's search decides. */
export function matchesTokens(haystack: string, query: string): boolean {
  const q = normalizeForMatch(query).split(' ').filter(Boolean);
  if (q.length === 0) return true;
  const h = normalizeForMatch(haystack).split(' ').filter(Boolean);
  return q.every((t) => h.some((w) => w.startsWith(t)));
}

/** A loaded brand's models, narrowed as typed, without a round trip. */
export function filterModels(models: BindingLookup[], query: string): BindingLookup[] {
  if (!query.trim()) return models;
  return models.filter((m) => matchesTokens(`${m.manufacturer} ${m.model}`, query));
}

/**
 * The brand list, A to Z. The tree keeps the item picker's own order, which
 * puts the makers it started with first; a lookup is easier to scan
 * alphabetically. Accents and case don't move a brand ("Kästle" by K).
 */
export function brandsAZ<T extends { label: string }>(brands: T[]): T[] {
  return [...brands].sort((a, b) => a.label.localeCompare(b.label, 'en', { sensitivity: 'base', numeric: true }));
}
