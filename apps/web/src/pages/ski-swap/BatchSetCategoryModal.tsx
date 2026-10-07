import { useCallback, useEffect, useRef, useState } from 'react';
import {
  faCircleCheck as faCircleCheckDuo, faCircleXmark as faCircleXmarkDuo, faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import type { CategorizeAnswer } from '../../lib/api.types';
import { useScanner } from '../../contexts/ScannerContext';
import ItemDescriber, { emptyDescriber, toAttributeInputs, type DescriberState } from '../../components/ItemDescriber';
import { Banner, ScannerBanner, errorTone, skipTone, successTone } from './ScanSessionParts';
import {
  bannerFor, counts, emptySession, failedBatch, landed, nextBatch, retryDelay, scanned, sending, toneFor, undone, undoRefused,
  type Pick, type Row, type RowOutcome, type Session,
} from './batchCategoryLogic';

const ICON = { ready: faCircleCheckDuo, warn: faTriangleExclamationDuo, error: faCircleXmarkDuo } as const;

const BADGE: Record<RowOutcome, { label: string; tone: string }> = {
  waiting: { label: 'Waiting', tone: 'bg-surface-200 text-gray-300' },
  sending: { label: 'Setting…', tone: 'bg-surface-200 text-gray-300' },
  set: { label: 'Set', tone: 'bg-green-900/50 text-green-300' },
  skipped: { label: 'Skipped', tone: 'bg-amber-900/40 text-amber-300' },
  already: { label: 'Already scanned', tone: 'bg-amber-900/30 text-amber-400' },
  not_found: { label: 'Not found', tone: 'bg-red-900/50 text-red-300' },
  failed: { label: 'Not set', tone: 'bg-red-900/50 text-red-300' },
  undone: { label: 'Undone', tone: 'bg-surface-200 text-gray-400' },
};

const play = (t: ReturnType<typeof toneFor>) => {
  if (t === 'success') successTone();
  else if (t === 'skip') skipTone();
  else if (t === 'error') errorTone();
};

/** Picks only (D3): a typed value would have been refused by the picker already. */
const answersOf = (d: DescriberState): CategorizeAnswer[] =>
  toAttributeInputs(d).flatMap((a): CategorizeAnswer[] => {
    if (a.valueId) return [{ attributeId: a.attributeId, valueId: a.valueId }];
    if (a.numberValue !== undefined) return [{ attributeId: a.attributeId, numberValue: a.numberValue }];
    return [];
  });

/**
 * Batch set category (Plan 45): pick a category and as many details as you
 * like, then scan. Each item with no category gets them; one that has a
 * category is skipped; nothing else changes unless Rename items is on.
 *
 * Built for a scanner in continuous mode. A scan is a row at once; rows go to
 * the server in batches, one request at a time, and every row ends with an
 * outcome and a sound (D5, D7, D8).
 */
export default function BatchSetCategoryModal({ orgId, swapId, onClose, onChanged }: {
  orgId: string;
  swapId: string;
  onClose: () => void;
  /** Something was set or undone: the Items list should refresh. */
  onChanged: () => void;
}) {
  const { subscribe, connected } = useScanner();
  const [describer, setDescriber] = useState<DescriberState>(emptyDescriber);
  const [preview, setPreview] = useState({ name: '', summary: '' });
  const [picking, setPicking] = useState(true);
  const [rename, setRename] = useState(false);
  const [session, setSession] = useState<Session>(emptySession);
  const sessionRef = useRef(session);
  const commit = (next: Session) => { sessionRef.current = next; setSession(next); };
  const [notice, setNotice] = useState<string | null>(null);
  const [pickedKey, setPickedKey] = useState<number | null>(null);
  /** Consecutive batches with no answer; while above zero the queue is retrying. */
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const [tick, setTick] = useState(0);

  // The pick each scan keeps (D3, D14).
  const pick: Pick | null = describer.categoryId
    ? { categoryId: describer.categoryId, attributes: answersOf(describer), rename, summary: preview.summary }
    : null;
  const pickRef = useRef(pick);
  pickRef.current = pick;

  const scan = useCallback((raw: string) => {
    const { session: next, effect } = scanned(sessionRef.current, raw, pickRef.current, Date.now());
    commit(next);
    if (effect === 'no_pick') {
      errorTone();
      setNotice('Pick a category first.');
      return;
    }
    if (effect === 'queued' || effect === 'already') {
      setNotice(null);
      setPickedKey(null);
    }
    if (effect === 'already') skipTone();
  }, []);

  // A category picked answers "Pick a category first".
  useEffect(() => { if (describer.categoryId) setNotice(null); }, [describer.categoryId]);

  // Every scan, for as long as the popover is open.
  useEffect(() => subscribe((s) => scan(s.payload)), [subscribe, scan]);

  // The drain: one batch in flight at a time; the next goes when it lands (D5).
  useEffect(() => {
    if (inFlight.current) return;
    const batch = nextBatch(sessionRef.current);
    if (!batch) return;
    inFlight.current = true;
    commit(sending(sessionRef.current, batch.keys));
    api.skiSwap.categorizeItems(orgId, swapId, {
      categoryId: batch.pick.categoryId, attributes: batch.pick.attributes, rename: batch.pick.rename, skus: batch.skus,
    })
      .then(({ results }) => {
        commit(landed(sessionRef.current, batch.keys, results));
        setAttempt(0);
        play(toneFor(results.map((r) => r.outcome)));
        if (results.some((r) => r.outcome === 'set')) onChanged();
        inFlight.current = false;
        setTick((t) => t + 1);
      })
      .catch((err: unknown) => {
        const e = err instanceof ApiError ? { status: err.status, message: err.message } : {};
        const { session: next, retry } = failedBatch(sessionRef.current, batch.keys, e);
        commit(next);
        if (retry) {
          // Nothing dropped: back to waiting, and again a little later (D7).
          setAttempt((a) => {
            const wait = retryDelay(a);
            setTimeout(() => { inFlight.current = false; setTick((t) => t + 1); }, wait);
            return a + 1;
          });
        } else {
          errorTone();
          inFlight.current = false;
          setTick((t) => t + 1);
        }
      });
  }, [session, tick, orgId, swapId, onChanged]);

  async function undo(row: Row) {
    if (!row.item) return;
    try {
      const out = await api.skiSwap.uncategorizeItem(orgId, swapId, row.item.id, {
        categoryId: row.pick.categoryId,
        attributes: row.pick.attributes,
        ...(row.item.previousName ? { rename: { from: row.item.previousName, to: row.item.name } } : {}),
      });
      commit(undone(sessionRef.current, row.key, out.name));
      setPickedKey(row.key);
      onChanged();
    } catch (err) {
      errorTone();
      commit(undoRefused(sessionRef.current, row.key, err instanceof Error ? err.message : 'Couldn’t undo.'));
      setPickedKey(row.key);
    }
  }

  function close() {
    const waiting = counts(sessionRef.current).waiting;
    if (waiting > 0 && !confirm(`${waiting} scan${waiting === 1 ? ' is' : 's are'} still waiting to be set. Close anyway?`)) return;
    onClose();
  }

  const rows = session.rows;
  const shown = rows.find((r) => r.key === pickedKey) ?? rows.find((r) => r.outcome !== 'waiting' && r.outcome !== 'sending') ?? null;
  const banner = shown ? bannerFor(shown) : null;
  const tally = counts(session);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 pt-[5vh] z-50" onClick={close}>
      <div role="dialog" aria-modal="true" aria-label="Batch set category"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-3xl p-5 space-y-4 max-h-[90vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-white font-medium">Batch set category</h3>
            <p className="text-gray-400 text-sm mt-0.5">
              Pick a category, then scan. Items with no category get it; items that have one are skipped. Nothing else changes.
            </p>
          </div>
          <button type="button" onClick={close} className="shrink-0 bg-surface-100 hover:bg-surface-200 text-gray-200 px-3 py-1.5 rounded text-sm">
            Done
          </button>
        </div>

        <div className="shrink-0 border border-gray-800 rounded-lg p-3 space-y-3">
          {picking ? (
            <>
              <div className="max-h-[38vh] overflow-y-auto pr-1">
                <ItemDescriber
                  orgId={orgId}
                  staff
                  typedValues={false}
                  value={describer}
                  onChange={setDescriber}
                  onPreview={setPreview}
                  layout="grid"
                />
              </div>
              {describer.categoryId && (
                <div className="flex justify-end">
                  <button type="button" onClick={() => setPicking(false)}
                    className="bg-brand-600 hover:bg-brand-500 text-white px-3 py-1.5 rounded text-sm font-medium">
                    Use this
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-white min-w-0 truncate" title={preview.summary}>{preview.summary}</p>
              <button type="button" onClick={() => setPicking(true)} className="shrink-0 text-sm text-gray-400 hover:text-white">Change</button>
            </div>
          )}
          <label className="flex items-start gap-2 text-sm text-gray-300 cursor-pointer select-none">
            <input type="checkbox" className="mt-0.5" checked={rename} onChange={(e) => setRename(e.target.checked)} />
            <span>
              Rename items
              <span className="block text-xs text-gray-500">
                {rename && preview.name
                  ? `Names each item from the category and details above, e.g. ${preview.name}. Printed tags keep the old name.`
                  : 'Off: each item keeps its name.'}
              </span>
            </span>
          </label>
        </div>

        <ScannerBanner typed={false} ready={{ title: rows.length ? 'Keep scanning' : 'Start scanning', text: 'Scan tags to set their category.' }} />

        {notice && <Banner tone="error" icon={faTriangleExclamationDuo} title={notice} text="Choose one above, then scan again." />}
        {attempt > 0 && tally.waiting > 0 && (
          <Banner tone="warn" icon={faTriangleExclamationDuo} title="Can’t reach PatrolKit"
            text={`${tally.waiting.toLocaleString('en-US')} waiting. Retrying; nothing is lost.`} />
        )}
        {!notice && banner && shown && <Banner tone={banner.tone} icon={ICON[banner.tone]} title={banner.title} text={banner.text} />}

        <div className="flex-1 min-h-0 flex flex-col">
          <p className="text-xs text-gray-400 mb-1 shrink-0">
            Set {tally.set.toLocaleString('en-US')} · Skipped {tally.skipped.toLocaleString('en-US')} · Not found {tally.notFound.toLocaleString('en-US')}
            {tally.failed > 0 ? ` · Not set ${tally.failed.toLocaleString('en-US')}` : ''} · Waiting {tally.waiting.toLocaleString('en-US')}
            {!connected && rows.length > 0 ? ' · scanner disconnected' : ''}
          </p>
          <ul className="flex-1 min-h-0 overflow-y-auto border border-gray-800 rounded divide-y divide-gray-800" aria-label="Scanned this session">
            {rows.length === 0 && <li className="px-3 py-3 text-sm text-gray-500">Each scan is listed here, newest first.</li>}
            {rows.map((r) => (
              <li key={r.key} className={`flex items-center gap-3 px-3 py-1.5 text-sm ${shown?.key === r.key ? 'bg-surface-100' : ''}`}>
                <button type="button" onClick={() => setPickedKey(r.key)} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                  <span className="font-mono text-gray-200 shrink-0">{r.sku}</span>
                  <span className="truncate text-gray-400">
                    {r.item
                      ? [r.item.name, r.item.sellerName, r.item.previousName ? `renamed from ${r.item.previousName}` : null].filter(Boolean).join(' · ')
                      : r.message ?? (r.outcome === 'not_found' ? 'No item has this SKU in this swap' : '')}
                    {r.item && r.message ? ` · ${r.message}` : ''}
                  </span>
                </button>
                <span className={`shrink-0 inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${BADGE[r.outcome].tone}`}>
                  {BADGE[r.outcome].label}
                </span>
                {r.outcome === 'set' && r.item && (
                  <button type="button" onClick={() => void undo(r)} className="shrink-0 text-xs text-gray-400 hover:text-white">Undo</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
