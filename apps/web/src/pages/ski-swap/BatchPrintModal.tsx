import { useRef, useState } from 'react';
import type { ItemResponse } from '../../lib/api.types';

type Run =
  | { state: 'ready' }
  | { state: 'printing'; done: number }
  | { state: 'stopped' | 'done'; done: number }
  | { state: 'failed'; done: number; at: string; error: string };

/**
 * Prints the label of every item on screen, one after another.
 *
 * Started from a button here rather than straight from the menu: the
 * browser only opens its printer picker in answer to a click, and the first
 * label may need it. Each item is marked printed as its labels come out, so
 * a run that stops part way leaves the list saying which are done.
 */
export default function BatchPrintModal({
  items,
  labelsPerItem,
  printItem,
  markPrinted,
  onClose,
}: {
  items: ItemResponse[];
  labelsPerItem: number;
  printItem: (item: ItemResponse) => Promise<void>;
  markPrinted: (item: ItemResponse) => Promise<void>;
  onClose: () => void;
}) {
  const [run, setRun] = useState<Run>({ state: 'ready' });
  const stop = useRef(false);
  const labels = items.length * labelsPerItem;
  const busy = run.state === 'printing';

  async function start(from = 0) {
    stop.current = false;
    let done = from;
    setRun({ state: 'printing', done });
    for (const item of items.slice(from)) {
      if (stop.current) { setRun({ state: 'stopped', done }); return; }
      try {
        for (let i = 0; i < labelsPerItem; i++) await printItem(item);
        await markPrinted(item);
      } catch (err: unknown) {
        // The printer picker dismissed: nothing printed, nothing to report.
        if ((err as { name?: string })?.name === 'NotFoundError') { setRun(done ? { state: 'stopped', done } : { state: 'ready' }); return; }
        setRun({ state: 'failed', done, at: item.sku, error: err instanceof Error ? err.message : 'The printer didn’t answer.' });
        return;
      }
      done += 1;
      setRun({ state: 'printing', done });
    }
    setRun({ state: 'done', done });
  }

  const done = run.state === 'ready' ? 0 : run.done;
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={busy ? undefined : onClose}>
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-5 max-w-sm w-full space-y-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-white font-medium">Batch print</h3>
        <p className="text-sm text-gray-400">
          {items.length.toLocaleString('en-US')} item{items.length === 1 ? '' : 's'} on this page,{' '}
          {labels.toLocaleString('en-US')} label{labels === 1 ? '' : 's'}
          {labelsPerItem > 1 ? ` (${labelsPerItem} each)` : ''}, in the order shown.
        </p>

        {run.state !== 'ready' && (
          <div className="space-y-1">
            <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
              <div className="h-full bg-brand-600 transition-all" style={{ width: `${(done / items.length) * 100}%` }} />
            </div>
            <p className="text-xs text-gray-400">
              {run.state === 'printing' && `Printing ${Math.min(done + 1, items.length)} of ${items.length}…`}
              {run.state === 'done' && <span className="text-green-400">All {items.length} printed.</span>}
              {run.state === 'stopped' && `Stopped after ${done} of ${items.length}.`}
              {run.state === 'failed' && (
                <span className="text-red-400">Stopped at {run.at} ({done} of {items.length} printed): {run.error}</span>
              )}
            </p>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          {busy ? (
            <button type="button" onClick={() => { stop.current = true; }} className="text-sm text-gray-300 hover:text-white px-3 py-2">
              Stop after this one
            </button>
          ) : (
            <button type="button" onClick={onClose} className="text-sm text-gray-400 hover:text-white px-3 py-2">
              {run.state === 'done' ? 'Done' : 'Close'}
            </button>
          )}
          {!busy && run.state !== 'done' && (
            <button
              type="button"
              onClick={() => void start(done)}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm"
            >
              {run.state === 'ready' ? 'Start printing' : 'Continue'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
