import { useState } from 'react';
import { api, getAccessToken } from '../../lib/api';

interface ParseResult {
  headers: string[];
  mapping: Record<string, string | null>;
  preview: Record<string, string>[];
  totalRows: number;
}

const FIELDS = [
  { key: 'firstName', label: 'First name', required: true },
  { key: 'lastName', label: 'Last name', required: true },
  { key: 'nspId', label: 'NSP ID', required: true },
  { key: 'patrolLevel', label: 'Patrol level', required: false },
] as const;

/**
 * Same two-step shape as the seller import: parse and map, then commit. Because columns
 * are mapped rather than fixed, whatever the patrol exports from its NSP records will do.
 */
export default function RosterImportModal({
  orgId,
  onClose,
  onImported,
}: {
  orgId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [strategy, setStrategy] = useState<'preserve' | 'overwrite'>('preserve');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: string[] } | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const token = getAccessToken();
      const res = await fetch(`/api/v1/orgs/${orgId}/time-clock/patrollers/import/parse`, {
        method: 'POST',
        credentials: 'include',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      });
      if (!res.ok) throw new Error('Could not read that CSV');
      const body = (await res.json()) as { data: ParseResult };
      setParsed(body.data);
      setMapping(body.data.mapping);

      // Keep the full file client-side: the parse endpoint only returns a preview.
      const text = await file.text();
      setRows(parseCsvClientSide(text));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const mapped = rows.map((row) => ({
        firstName: mapping.firstName ? (row[mapping.firstName] ?? '') : '',
        lastName: mapping.lastName ? (row[mapping.lastName] ?? '') : '',
        nspId: mapping.nspId ? (row[mapping.nspId] ?? '') : '',
        patrolLevel: mapping.patrolLevel ? (row[mapping.patrolLevel] ?? null) : null,
      }));
      setResult(await api.timeClock.importPatrollers(orgId, mapped, strategy));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div className="bg-surface-200 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-white font-semibold">Import Roster from CSV</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {error && <p className="text-red-400 text-sm">{error}</p>}

          {result ? (
            <div className="space-y-3 text-sm">
              <p className="text-white">
                {result.created} added, {result.updated} updated, {result.skipped} skipped.
              </p>
              {result.errors.length > 0 && (
                <ul className="text-yellow-400 space-y-1 max-h-40 overflow-y-auto">
                  {result.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              <button onClick={onImported} className="bg-red-600 hover:bg-red-500 text-white rounded px-3 py-1.5">
                Done
              </button>
            </div>
          ) : !parsed ? (
            <div className="space-y-3 text-sm text-gray-400">
              <p>Required columns: <span className="text-white">first name, last name, NSP ID</span>. Patrol level is optional.</p>
              <a href={`/api/v1/orgs/${orgId}/time-clock/patrollers/import/template`} className="text-red-400 hover:text-red-300 block">
                ↓ Download template CSV
              </a>
              <input type="file" accept=".csv,text/csv" disabled={busy}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
                className="block text-sm text-gray-300" />
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-gray-400 text-sm">
                Map your CSV columns to roster fields. Auto-detected where possible. {parsed.totalRows} rows found.
              </p>
              <div className="space-y-2">
                {FIELDS.map((field) => (
                  <div key={field.key} className="flex items-center gap-3">
                    <label className="text-sm text-gray-300 w-28">
                      {field.label}{field.required && <span className="text-red-400"> *</span>}
                    </label>
                    <select
                      value={mapping[field.key] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [field.key]: e.target.value || null })}
                      className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white flex-1"
                    >
                      <option value="">— none —</option>
                      {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <label className="text-sm text-gray-300 w-28">Existing rows</label>
                <select value={strategy} onChange={(e) => setStrategy(e.target.value as 'preserve' | 'overwrite')}
                  className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white flex-1">
                  <option value="preserve">Keep existing (skip)</option>
                  <option value="overwrite">Overwrite with CSV data</option>
                </select>
              </div>

              <button
                onClick={commit}
                disabled={busy || !mapping.firstName || !mapping.lastName || !mapping.nspId}
                className="bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white rounded px-4 py-2 text-sm"
              >
                {busy ? 'Importing…' : `Import ${rows.length} rows`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Minimal RFC-4180 reader — enough for a roster export with quoted fields. */
function parseCsvClientSide(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') inQuotes = false;
      else field += char;
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!header) return [];
  return body.map((cells) =>
    Object.fromEntries(header.map((h, i) => [h.trim(), (cells[i] ?? '').trim()])),
  );
}
