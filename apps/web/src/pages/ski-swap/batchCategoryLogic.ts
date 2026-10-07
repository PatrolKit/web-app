import type { CategorizeAnswer, CategorizeItemResult } from '../../lib/api.types';

/**
 * Batch set category's session (Plan 45), kept apart from the popover so it
 * can be tested: scans queue as rows at once, and go to the server in small
 * batches, one request at a time (D5). Every row ends in an outcome and a
 * sound; nothing stops the session (D7).
 */

/** What a scan is set to: the category, its details, and whether to rename (D3, D14). */
export interface Pick {
  categoryId: string;
  attributes: CategorizeAnswer[];
  rename: boolean;
  /** "Skis · Bindings included: Yes · Manufacturer: Marker", for the rows. */
  summary: string;
}

export type RowOutcome =
  | 'waiting'
  | 'sending'
  | 'set'
  | 'skipped'
  | 'not_found'
  | 'failed'
  | 'already'
  | 'undone';

export interface Row {
  /** Unique per scan. */
  key: number;
  sku: string;
  pick: Pick;
  outcome: RowOutcome;
  item?: CategorizeItemResult['item'];
  /** The server's sentence, for a failure or a refused undo. */
  message?: string;
}

export interface Session {
  /** Newest first. */
  rows: Row[];
  /** When each SKU was last read, for the continuous-mode repeat (D6). */
  lastSeen: Record<string, number>;
  nextKey: number;
}

export const emptySession: Session = { rows: [], lastSeen: {}, nextKey: 1 };

/** A held tag, read again by a scanner in continuous mode, inside this is the same scan. */
export const REPEAT_MS = 3000;
export const BATCH_SIZE = 25;

/** Two picks are the same batch only when every part matches. */
export const pickKey = (p: Pick) =>
  JSON.stringify([p.categoryId, [...p.attributes].sort((a, b) => a.attributeId.localeCompare(b.attributeId)), p.rename]);

export type ScanEffect = 'queued' | 'repeat' | 'already' | 'no_pick' | 'blank';

/** A scan. Queued at once; or dropped as a held tag; or answered here as already scanned (D6). */
export function scanned(s: Session, raw: string, pick: Pick | null, now: number): { session: Session; effect: ScanEffect } {
  const sku = raw.trim();
  if (!sku) return { session: s, effect: 'blank' };
  if (!pick) return { session: s, effect: 'no_pick' };
  const last = s.lastSeen[sku];
  const lastSeen = { ...s.lastSeen, [sku]: now };
  if (last !== undefined && now - last < REPEAT_MS) return { session: { ...s, lastSeen }, effect: 'repeat' };
  // Scanned before and still standing: answered here, no request. A row that
  // failed or was undone can be scanned again, and is.
  const before = s.rows.find((r) => r.sku === sku && r.outcome !== 'failed' && r.outcome !== 'undone' && r.outcome !== 'already');
  const row: Row = before
    ? { key: s.nextKey, sku, pick, outcome: 'already', item: before.item }
    : { key: s.nextKey, sku, pick, outcome: 'waiting' };
  return { session: { rows: [row, ...s.rows], lastSeen, nextKey: s.nextKey + 1 }, effect: before ? 'already' : 'queued' };
}

/** The next batch: the oldest waiting scan's pick, and up to 25 waiting scans that share it. */
export function nextBatch(s: Session): { pick: Pick; keys: number[]; skus: string[] } | null {
  const waiting = s.rows.filter((r) => r.outcome === 'waiting').reverse(); // oldest first
  if (waiting.length === 0) return null;
  const key = pickKey(waiting[0].pick);
  const batch = waiting.filter((r) => pickKey(r.pick) === key).slice(0, BATCH_SIZE);
  return { pick: waiting[0].pick, keys: batch.map((r) => r.key), skus: [...new Set(batch.map((r) => r.sku))] };
}

const patch = (s: Session, keys: number[], f: (r: Row) => Row): Session => {
  const ks = new Set(keys);
  return { ...s, rows: s.rows.map((r) => (ks.has(r.key) ? f(r) : r)) };
};

export const sending = (s: Session, keys: number[]) => patch(s, keys, (r) => ({ ...r, outcome: 'sending' }));

/** The server's answer for a batch. */
export function landed(s: Session, keys: number[], results: CategorizeItemResult[]): Session {
  const bySku = new Map(results.map((r) => [r.sku, r]));
  return patch(s, keys, (r) => {
    const res = bySku.get(r.sku);
    if (!res) return { ...r, outcome: 'failed', message: 'No answer for this tag.' };
    return { ...r, outcome: res.outcome, item: res.item };
  });
}

/**
 * A batch with no answer (D7). No status, a server error, a timeout or a
 * rate limit: back to waiting, to retry. Anything else is the server
 * refusing these scans, with its sentence.
 */
export function failedBatch(s: Session, keys: number[], err: { status?: number; message?: string }): { session: Session; retry: boolean } {
  const retry = err.status === undefined || err.status >= 500 || err.status === 408 || err.status === 429;
  return {
    session: patch(s, keys, (r) => (retry ? { ...r, outcome: 'waiting' } : { ...r, outcome: 'failed', message: err.message ?? 'Not set.' })),
    retry,
  };
}

/** 1, 2, 5, 10 seconds, then every 10 (D7). */
export function retryDelay(attempt: number): number {
  return [1000, 2000, 5000, 10000][Math.min(attempt, 3)];
}

export const undone = (s: Session, key: number, name?: string) =>
  patch(s, [key], (r) => ({ ...r, outcome: 'undone', message: undefined, item: r.item && name ? { ...r.item, name, previousName: null } : r.item }));
export const undoRefused = (s: Session, key: number, message: string) => patch(s, [key], (r) => ({ ...r, message }));

export function counts(s: Session): { set: number; skipped: number; notFound: number; failed: number; waiting: number } {
  const n = (o: RowOutcome[]) => s.rows.filter((r) => o.includes(r.outcome)).length;
  return { set: n(['set']), skipped: n(['skipped']), notFound: n(['not_found']), failed: n(['failed']), waiting: n(['waiting', 'sending']) };
}

export type Tone = 'success' | 'skip' | 'error';

/** One sound for what landed together: the worst of it (D8). */
export function toneFor(outcomes: RowOutcome[]): Tone | null {
  if (outcomes.some((o) => o === 'not_found' || o === 'failed')) return 'error';
  if (outcomes.some((o) => o === 'skipped' || o === 'already')) return 'skip';
  if (outcomes.some((o) => o === 'set')) return 'success';
  return null;
}

/** What the big banner says about a row. */
export function bannerFor(r: Row): { tone: 'ready' | 'warn' | 'error'; title: string; text: string } | null {
  const what = r.item ? `${r.sku} · ${r.item.name}` : r.sku;
  switch (r.outcome) {
    case 'waiting':
    case 'sending':
      return null;
    case 'set':
      return {
        tone: 'ready',
        title: `Set to ${r.item?.categoryLabel ?? 'the category'}`,
        text: r.item?.previousName ? `${r.sku} · renamed from ${r.item.previousName} to ${r.item.name}` : what,
      };
    case 'skipped':
      return { tone: 'warn', title: `Skipped: already ${article(r.item?.categoryLabel)}`, text: what };
    case 'already':
      return { tone: 'warn', title: 'Already scanned this session', text: what };
    case 'not_found':
      return { tone: 'error', title: 'Not found', text: `${r.sku}: no item has this SKU in this swap.` };
    case 'failed':
      return { tone: 'error', title: 'Not set', text: `${r.sku}: ${r.message ?? 'Something went wrong.'}` };
    case 'undone':
      return { tone: 'warn', title: 'Undone', text: `${what}: no category again.` };
  }
}

/** "a Boots item", "an Accessories item". */
function article(label: string | null | undefined): string {
  if (!label) return 'categorized';
  return `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} item`;
}
