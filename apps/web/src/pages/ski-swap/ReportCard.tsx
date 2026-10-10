import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Side } from './salesCheckView';
import type { IssueNote } from '../../lib/api.types';

/**
 * The Reports tab's cards (Plan 48), shared by Sales check and Catalog check:
 * one side of a comparison as labelled fields with its links, the tombstone
 * a decided card leaves in its place, and sections that fold.
 */

/**
 * Which sections are folded, kept in the browser under `storageKey`, so a
 * reload or the next read leaves them as they were. Each change builds on
 * the latest folds, so quick clicks don't undo each other.
 */
export function useFolds(storageKey: string) {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as unknown;
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const change = (to: (prev: Set<string>) => Iterable<string>) => setFolded((prev) => {
    const next = new Set(to(prev));
    try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* private window: folds just aren't kept */ }
    return next;
  });
  return {
    isFolded: (key: string) => folded.has(key),
    toggle: (key: string) => change((prev) => (prev.has(key) ? [...prev].filter((k) => k !== key) : [...prev, key])),
    /** All folded: unfold them all. Otherwise fold them all. */
    toggleAll: (keys: string[]) => change((prev) => (keys.every((k) => prev.has(k)) ? [] : keys)),
    allFolded: (keys: string[]) => keys.length > 0 && keys.every((k) => folded.has(k)),
  };
}

/**
 * Whether a card was open on screen and has just been decided, by its own
 * button or a whole group's: its tombstone settles in green, where one
 * decided before the page loaded just sits there.
 */
export function useJustDecided(open: boolean): boolean {
  const wasOpen = useRef(open);
  const [just, setJust] = useState(false);
  useEffect(() => {
    if (wasOpen.current && !open) setJust(true);
    wasOpen.current = open;
  }, [open]);
  return just;
}

/**
 * A long batch at work (Accept all, a whole group's choice): a spinner, what
 * it's doing, and the time so far, so a minute's wait reads as working.
 */
export function BusyBanner({ what }: { what: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(tick);
  }, []);
  const took = seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-lg border border-brand-700/60 bg-brand-900/20 px-3 py-2.5 text-sm">
      <span className="h-4 w-4 shrink-0 rounded-full border-2 border-brand-400 border-t-transparent animate-spin" aria-hidden="true" />
      <span className="text-gray-100">{what}</span>
      <span className="ml-auto text-xs text-gray-400 tabular-nums">{took} · keep this page open</span>
    </div>
  );
}

/**
 * A person's note on an issue (Plan 48): what they looked up and found, for
 * whoever decides. "Add note" when there's none; the note, who wrote it and
 * when, once there is. Saving an empty note clears it.
 */
export function NoteBox({ note, canEdit, onSave }: {
  note: IssueNote | null | undefined; canEdit: boolean; onSave: (text: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The note wasn’t saved. Try again.');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="space-y-1.5">
        <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000}
          placeholder="What you looked up, what you found, who should decide…"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save(); if (e.key === 'Escape') setEditing(false); }}
          className="w-full bg-surface-100 border border-gray-700 focus:border-brand-500 rounded px-2.5 py-2 text-sm text-white" />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button type="button" disabled={saving} onClick={() => void save()}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-2.5 py-1 rounded font-medium">
            {saving ? 'Saving…' : draft.trim() ? 'Save note' : note ? 'Clear note' : 'Save note'}
          </button>
          <button type="button" disabled={saving} onClick={() => setEditing(false)} className="text-gray-400 hover:text-white">Cancel</button>
          <span className="text-gray-500">⌘↵ saves</span>
          {error && <span className="text-red-400">{error}</span>}
        </div>
      </div>
    );
  }
  if (note) {
    const when = new Date(note.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return (
      <div className="rounded border border-sky-800/60 bg-sky-950/30 px-2.5 py-2 text-xs">
        <p className="text-sky-300 font-medium mb-0.5">Note</p>
        <p className="whitespace-pre-wrap break-words text-gray-200 text-sm">{note.text}</p>
        <p className="mt-1 text-gray-500">
          {note.updatedByName ?? 'Someone'}, {when}
          {canEdit && <> · <button type="button" className="text-brand-500 hover:underline" onClick={() => { setDraft(note.text); setEditing(true); }}>Edit</button></>}
        </p>
      </div>
    );
  }
  return canEdit ? (
    <button type="button" className="text-xs text-brand-500 hover:underline" onClick={() => { setDraft(''); setEditing(true); }}>+ Add note</button>
  ) : null;
}

/** A section's header that folds it: ▾ open, ▸ folded. */
export function FoldHeader({ folded, onToggle, children }: { folded: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={!folded} className="w-full flex items-baseline gap-2 text-left">
      <span className="text-gray-500 w-3 shrink-0">{folded ? '▸' : '▾'}</span>
      {children}
    </button>
  );
}

/** Where a decided sale was: says what was done, and settles in so the change is seen. */
export function Tombstone({ text, hint = 'Undo it under Decided.', settle = true }: { text: string; hint?: string; settle?: boolean }) {
  return (
    <div role="status" className={`${settle ? 'animate-settle' : 'bg-green-500/5'} flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-green-800/60 px-3 py-2.5 text-sm`}>
      <span className="text-green-400">✓</span>
      <span className="text-green-200 min-w-0 break-words">{text}</span>
      {hint && <span className="ml-auto text-xs text-gray-500">{hint}</span>}
    </div>
  );
}

export function SidePanel({ side, icon, className = '', action }: { side: Side; icon: string; className?: string; action?: ReactNode }) {
  return (
    <div className={`p-3 min-w-0 flex flex-col ${className}`}>
      <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">{icon} {side.title}</p>
      {side.empty ? <p className="text-xs text-gray-400">{side.empty}</p> : (
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 text-sm">
          {side.fields.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-xs text-gray-500 pt-0.5">{f.label}</dt>
              <dd className={`min-w-0 break-words ${f.mono ? 'font-mono' : ''} ${f.warn ? 'text-amber-400' : 'text-gray-200'}`}>
                {f.value}
                {f.tag && <span className="ml-1.5 inline-block whitespace-nowrap text-[11px] bg-amber-900/40 text-amber-300 rounded px-1.5 py-px font-sans">{f.tag}</span>}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {side.links.length > 0 && (
        <p className="mt-2 flex gap-3 text-xs">
          {side.links.map((l) => 'href' in l
            ? <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">{l.label} ↗</a>
            : <Link key={l.label} to={l.to} className="text-brand-500 hover:underline">{l.label} ›</Link>)}
        </p>
      )}
      {/* Pinned to the bottom, so side-by-side panels' buttons line up. */}
      {action && <div className="mt-auto pt-2.5">{action}</div>}
    </div>
  );
}
