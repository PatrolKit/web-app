import { useState } from 'react';
import { api } from '../../lib/api';
import type { ImportOutcome, MemberImportField, MemberImportParse } from '../../lib/api.types';

const FIELDS: { key: MemberImportField; label: string }[] = [
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'nspId', label: 'NSP ID' },
  { key: 'patrolLevel', label: 'Patrol level' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'permissions', label: 'Permissions' },
];

const OUTCOMES: Record<ImportOutcome['outcome'], string> = {
  created: 'Added',
  invited: 'Added and invited',
  updated: 'Updated',
  already_member: 'Already a member, left as is',
  error: 'Not imported',
};

/**
 * One import for everyone (Plan 57 D10): parse and map, then commit. Columns are
 * mapped rather than fixed, so whatever the patrol exports from its NSP records
 * will do. Each row needs an email, a phone or an NSP ID, and a name without an
 * email.
 */
export default function MemberImportModal({
  orgId,
  onClose,
  onImported,
}: {
  orgId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const [parsed, setParsed] = useState<MemberImportParse | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<MemberImportField, string | null>>>({});
  const [strategy, setStrategy] = useState<'preserve' | 'overwrite'>('preserve');
  const [sendInvites, setSendInvites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ImportOutcome[] | null>(null);

  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const p = await api.members.parseImport(orgId, file);
      setParsed(p);
      setMapping(p.mapping);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!parsed) return;
    setBusy(true);
    setError(null);
    try {
      const rows = parsed.rows.map((row) =>
        Object.fromEntries(FIELDS.map(({ key }) => [key, mapping[key] ? (row[mapping[key]!] ?? null) : null])),
      );
      setResults(await api.members.importRows(orgId, { rows, strategy, sendInvites }));
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const mapped = (k: MemberImportField) => !!mapping[k];
  const canIdentify = mapped('email') || mapped('phone') || mapped('nspId');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
      <div role="dialog" aria-labelledby="member-import-title" className="bg-surface-200 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 id="member-import-title" className="text-white font-semibold">Import members from a CSV</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {error && <p className="text-red-400 text-sm" role="alert">{error}</p>}

          {results ? (
            <div className="space-y-3 text-sm">
              <p className="text-white">
                {results.filter((r) => r.outcome === 'created' || r.outcome === 'invited').length} added,{' '}
                {results.filter((r) => r.outcome === 'updated').length} updated,{' '}
                {results.filter((r) => r.outcome === 'already_member').length} already members,{' '}
                {results.filter((r) => r.outcome === 'error').length} not imported.
              </p>
              <table className="w-full text-sm">
                <thead><tr className="text-left text-gray-500">
                  <th className="py-1 pr-4">Row</th><th className="py-1 pr-4">Who</th><th className="py-1">Outcome</th>
                </tr></thead>
                <tbody>{results.map((r) => (
                  <tr key={r.row} className="border-t border-gray-800 align-top">
                    <td className="py-1 pr-4 text-gray-500">{r.row}</td>
                    <td className="py-1 pr-4 text-white">{r.name || '—'}</td>
                    <td className={`py-1 ${r.outcome === 'error' ? 'text-red-400' : 'text-gray-300'}`}>
                      {OUTCOMES[r.outcome]}{r.error ? `: ${r.error}` : ''}
                    </td>
                  </tr>
                ))}</tbody>
              </table>
              <button onClick={onClose} className="bg-brand-600 hover:bg-brand-700 text-white rounded px-3 py-1.5">Done</button>
            </div>
          ) : !parsed ? (
            <div className="space-y-3 text-sm text-gray-400">
              <p>
                One row per person. Each needs an email, a phone number or an NSP ID, and a first and last name if it
                has no email. Any column names will do: you match them up next.
              </p>
              <input type="file" accept=".csv,text/csv" disabled={busy} aria-label="CSV file"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }}
                className="block text-sm text-gray-300" />
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-gray-400 text-sm">
                Match your columns to member fields; the ones it recognised are filled in. {parsed.totalRows} rows found.
              </p>
              <div className="space-y-2">
                {FIELDS.map((field) => (
                  <div key={field.key} className="flex items-center gap-3">
                    <label htmlFor={`map-${field.key}`} className="text-sm text-gray-300 w-28">{field.label}</label>
                    <select
                      id={`map-${field.key}`}
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
                <label htmlFor="import-strategy" className="text-sm text-gray-300 w-28">Existing members</label>
                <select id="import-strategy" value={strategy} onChange={(e) => setStrategy(e.target.value as 'preserve' | 'overwrite')}
                  className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-sm text-white flex-1">
                  <option value="preserve">Leave them as they are</option>
                  <option value="overwrite">Update them from the file</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} className="accent-brand-600" />
                Email new members an invite to sign in
              </label>

              {!canIdentify && <p className="text-gray-500 text-xs">Match at least one of email, phone or NSP ID.</p>}
              <button
                onClick={() => void commit()}
                disabled={busy || !canIdentify}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white rounded px-4 py-2 text-sm"
              >
                {busy ? 'Importing…' : `Import ${parsed.totalRows} rows`}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
