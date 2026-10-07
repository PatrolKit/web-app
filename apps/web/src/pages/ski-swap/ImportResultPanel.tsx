import { useState } from 'react';
import type { TicketImportResult } from '../../lib/api.types';
import { importedSummary } from './ImportSkuOptions';
import { groupUnknowns, importAnywaySummary, unknownCount, unknownsText, type UnknownGroup } from './importUnknowns';

/**
 * How an upload went (Plan 42 D6), for staff's upload and a shop's own.
 *
 * A refusal writes nothing, so the whole file is reported at once: row errors,
 * which only a changed file fixes, and unknowns, grouped so that adding one
 * value fixes every row that uses it. With unknowns and no row errors, the
 * file can be imported anyway, without them.
 */
export default function ImportResultPanel({
  result,
  forWhom,
  busy,
  onImportAnyway,
}: {
  result: TicketImportResult;
  /** Staff's upload names the seller it was for. */
  forWhom?: string;
  busy: boolean;
  onImportAnyway: () => void;
}) {
  const failures = result.rows.filter((r) => r.outcome === 'error');
  const groups = groupUnknowns(result.rows);
  const written = result.rows.filter((r) => r.outcome === 'created' || r.outcome === 'updated');

  function importAnyway() {
    const n = unknownCount(result.rows);
    if (confirm(`Import without ${n.toLocaleString('en-US')} value${n === 1 ? '' : 's'}? They won’t be saved, and the rest of each row will be.`)) {
      onImportAnyway();
    }
  }

  return (
    <div className="space-y-3">
      {failures.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-amber-400">
            {result.refused === 'errors'
              ? <>Nothing was imported{forWhom ? ` for ${forWhom}` : ''}. {failures.length} row{failures.length === 1 ? '' : 's'} need{failures.length === 1 ? 's' : ''} fixing first.</>
              // Written, but these changed in between: the rest went in.
              : <>{failures.length} row{failures.length === 1 ? '' : 's'} couldn’t be saved, and the rest were:</>}
          </p>
          <ul className="space-y-1 text-xs">
            {failures.map((r) => (
              <li key={r.line} className="text-gray-400">
                <span className="text-gray-500">Line {r.line}</span>
                {r.sku ? <span className="font-mono text-gray-300"> {r.sku}</span> : null}
                {' — '}
                <span className="text-red-400">{r.error}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {groups.length > 0 && result.refused !== null && (
        <div className="space-y-2">
          <p className="text-sm text-amber-400">
            {result.refused === 'unknown' ? 'Nothing was imported yet. ' : 'Also, '}
            {groups.length === 1 ? 'one value isn’t' : `${groups.length} values aren’t`} in our lists:
          </p>
          <UnknownList groups={groups} />
        </div>
      )}

      {result.ignoredColumns.length > 0 && (
        <p className="text-xs text-gray-500">Ignored columns: {result.ignoredColumns.join(', ')}</p>
      )}

      {result.refused === 'unknown' && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-gray-700 rounded px-3 py-2">
          <p className="text-xs text-gray-400">Import anyway would write {importAnywaySummary(result.rows)}.</p>
          <button
            type="button"
            onClick={importAnyway}
            disabled={busy}
            className="bg-surface-100 hover:bg-surface-200 text-gray-100 px-3 py-1.5 rounded text-sm disabled:opacity-40"
          >
            {busy ? 'Importing…' : 'Import anyway'}
          </button>
        </div>
      )}

      {result.refused === null && written.length > 0 && (
        <p className="text-sm text-green-400">{importedSummary(written, forWhom)}</p>
      )}
    </div>
  );
}

function UnknownList({ groups }: { groups: UnknownGroup[] }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(unknownsText(groups));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* the list is on screen either way */ }
  }
  return (
    <div className="space-y-1">
      <ul className="space-y-1 text-xs">
        {groups.map((g) => (
          <li key={g.key}>
            <details>
              <summary className="cursor-pointer text-gray-300">
                {g.label}
                {g.note && <span className="text-gray-500"> ({g.note})</span>}
                <span className="text-gray-500"> · {g.lines.length.toLocaleString('en-US')} row{g.lines.length === 1 ? '' : 's'}</span>
              </summary>
              <p className="pl-4 text-gray-500">Line{g.lines.length === 1 ? '' : 's'} {g.lines.join(', ')}</p>
            </details>
          </li>
        ))}
      </ul>
      <button type="button" onClick={copy} className="text-xs text-brand-500 hover:underline">
        {copied ? 'Copied' : 'Copy the list'}
      </button>
    </div>
  );
}
