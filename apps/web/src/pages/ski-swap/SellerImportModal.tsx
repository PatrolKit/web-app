import { useState } from 'react';
import { api } from '../../lib/api';

const FIELDS = ['name', 'phone', 'email', 'street', 'city', 'state', 'zip'] as const;
const FIELD_LABELS: Record<string, string> = {
  name: 'Name *', phone: 'Phone *', email: 'Email *',
  street: 'Street', city: 'City', state: 'State', zip: 'ZIP',
};

type Step = 'upload' | 'map' | 'results';

interface ImportResult { row: number; outcome: string; name?: string; phone?: string; error?: string; warning?: string; }

export default function SellerImportModal({ orgId, onClose, onDone }: { orgId: string; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [duplicateStrategy, setDuplicateStrategy] = useState<'overwrite' | 'preserve'>('preserve');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ImportResult[]>([]);
  const [outcomeFilter, setOutcomeFilter] = useState<string | null>(null);

  async function handleFileParsed(f: File) {
    setFile(f);
    setError(null);
    setLoading(true);
    try {
      const res = await api.skiSwap.parseSellerCsv(orgId, f);
      if (!res.success) { setError('Could not parse file'); return; }
      const { headers, mapping: detected, preview: rows, totalRows: total } = res.data;
      setCsvHeaders(headers);
      setMapping(detected);
      setPreview(rows);
      setTotalRows(total);
      setStep('map');
    } catch { setError('Failed to parse file'); }
    finally { setLoading(false); }
  }

  async function handleImport() {
    if (!file) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.skiSwap.importSellers(orgId, file, mapping, duplicateStrategy);
      if (!res.success) { setError('Import failed'); return; }
      setResults(res.data);
      setStep('results');
      onDone();
    } catch { setError('Import failed'); }
    finally { setLoading(false); }
  }

  const outcomeColor = (o: string) => ({ created: 'text-green-400', updated: 'text-blue-400', warning: 'text-yellow-400', skipped: 'text-gray-400', error: 'text-red-400' }[o] ?? 'text-gray-400');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-surface-50 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <h2 className="text-white font-semibold">Import Sellers from CSV</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && <p className="text-red-400 text-sm">{error}</p>}

          {/* ── Step 1: Upload ── */}
          {step === 'upload' && (
            <div className="space-y-4">
              <p className="text-gray-400 text-sm">
                <p>Required columns: <span className="text-white">name, phone, email</span></p>
              <p>Optional: <span className="text-white">street, city, state, zip</span></p>
              </p>
              <a
                href={api.skiSwap.downloadSellerTemplate(orgId)}
                className="inline-block text-sm text-brand-500 hover:underline"
              >
                ↓ Download template CSV
              </a>
              <label className="block">
                <span className="text-gray-400 text-xs uppercase">CSV file</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileParsed(f); }}
                  className="mt-1 block text-sm text-gray-300"
                />
              </label>
              {loading && <p className="text-gray-400 text-sm">Parsing…</p>}
            </div>
          )}

          {/* ── Step 2: Map + preview ── */}
          {step === 'map' && (
            <div className="space-y-5">
              {/* Column mapping */}
              <div>
                <p className="text-gray-400 text-sm mb-3">
                  Map your CSV columns to seller fields. Auto-detected where possible.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {FIELDS.map((field) => (
                    <label key={field} className="flex items-center gap-2 text-sm">
                      <span className="text-gray-400 w-16 shrink-0">{FIELD_LABELS[field]}</span>
                      <select
                        value={mapping[field] ?? ''}
                        onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}
                        className="flex-1 bg-surface-100 border border-gray-700 rounded px-2 py-1 text-white text-xs"
                      >
                        <option value="">— not mapped —</option>
                        {csvHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </div>

              {/* Duplicate strategy */}
              <div>
                <p className="text-gray-400 text-xs uppercase mb-2">If phone number already exists</p>
                <div className="flex gap-4">
                  {(['preserve', 'overwrite'] as const).map((s) => (
                    <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="radio" checked={duplicateStrategy === s} onChange={() => setDuplicateStrategy(s)} className="accent-brand-600" />
                      <span className="text-gray-300">{s === 'preserve' ? 'Keep existing (skip)' : 'Overwrite with CSV data'}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Preview */}
              {preview.length > 0 && mapping.name && mapping.phone && (
                <div>
                  <p className="text-gray-400 text-xs uppercase mb-2">Preview (first {preview.length} of {totalRows} rows)</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-500 text-left border-b border-gray-800">
                          {['name', 'phone', 'email'].map((f) => mapping[f] && <th key={f} className="pb-1 pr-3 capitalize">{f}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.map((row, i) => (
                          <tr key={i} className="border-b border-gray-900">
                            {['name', 'phone', 'email'].map((f) => mapping[f] && (
                              <td key={f} className="py-1 pr-3 text-gray-300">{row[mapping[f]] || '—'}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Results ── */}
          {step === 'results' && (
            <div className="space-y-3">
              <div className="flex gap-2 flex-wrap">
                {(['created', 'updated', 'warning', 'skipped', 'error'] as const).map((o) => {
                  const count = results.filter((r) => r.outcome === o).length;
                  if (!count) return null;
                  const active = outcomeFilter === o;
                  return (
                    <button
                      key={o}
                      onClick={() => setOutcomeFilter(active ? null : o)}
                      className={`text-xs px-2 py-1 rounded border transition ${active ? 'border-current bg-white/10' : 'border-transparent'} ${outcomeColor(o)}`}
                    >
                      {count} {o}
                    </button>
                  );
                })}
                {outcomeFilter && (
                  <button onClick={() => setOutcomeFilter(null)} className="text-xs text-gray-500 hover:text-gray-300 underline">
                    show all
                  </button>
                )}
              </div>
              <div className="overflow-y-auto max-h-64">
                <table className="w-full text-xs">
                  <thead><tr className="text-gray-500 text-left border-b border-gray-800">
                    <th className="pb-1 pr-2">Row</th><th className="pb-1 pr-2">Name</th>
                    <th className="pb-1 pr-2">Phone</th><th className="pb-1">Outcome</th>
                  </tr></thead>
                  <tbody>
                    {results.filter((r) => !outcomeFilter || r.outcome === outcomeFilter).map((r) => (
                      <tr key={r.row} className="border-b border-gray-900">
                        <td className="py-0.5 pr-2 text-gray-500">{r.row}</td>
                        <td className="py-0.5 pr-2 text-gray-300">{r.name}</td>
                        <td className="py-0.5 pr-2 text-gray-400 font-mono">{r.phone}</td>
                        <td className={`py-0.5 ${outcomeColor(r.outcome)}`}>{r.outcome}{r.error ? ` — ${r.error}` : r.warning ? ` — ${r.warning}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-gray-700 flex justify-end gap-2">
          {step === 'map' && (
            <>
              <button onClick={() => setStep('upload')} className="text-gray-400 hover:text-white text-sm px-3 py-2">Back</button>
              <button
                onClick={handleImport}
                disabled={loading || !mapping.name || !mapping.phone || !mapping.email}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
              >
                {loading ? 'Importing…' : `Import ${totalRows} rows`}
              </button>
            </>
          )}
          {(step === 'upload' || step === 'results') && (
            <button onClick={onClose} className="text-gray-400 hover:text-white text-sm px-3 py-2">
              {step === 'results' ? 'Close' : 'Cancel'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
