import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { IndemnificationImportPlan, IndemnificationProgram } from '../../lib/api.types';

/**
 * The indemnified-bindings registry's maintenance (Plan 44 D3, D8).
 *
 * The seasonal import, checked before it's written; each program's notes; the
 * import history; and which patrols have declared NSSRA membership. The model
 * nodes it mints are edited in Item Details like any other value.
 */

/** "2025-26" for a date in the autumn of 2025, or the spring of 2026. */
function guessSeason(now = new Date()): string {
  const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const details = err.details as { errors?: { line: number; message: string }[] } | undefined;
    if (details?.errors?.length) return `${err.message}: ${details.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.message}`).join('; ')}`;
    return err.message;
  }
  return (err as Error)?.message ?? 'That did not work';
}

function PlanView({ plan }: { plan: IndemnificationImportPlan }) {
  const [openLapse, setOpenLapse] = useState<string | null>(null);
  const lapsing = plan.lapsing.reduce((n, l) => n + l.models.length, 0);
  return (
    <div className="space-y-3 text-sm">
      {plan.errors.length > 0 && (
        <div className="space-y-1">
          <p className="text-red-400">{plan.errors.length} row error{plan.errors.length === 1 ? '' : 's'}; nothing will be written:</p>
          <ul className="text-xs text-red-300 max-h-40 overflow-y-auto">
            {plan.errors.map((e, i) => <li key={i}>line {e.line}: {e.message}</li>)}
          </ul>
        </div>
      )}
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs">
        <dt className="text-gray-500">Rows</dt><dd className="text-white">{plan.rows}</dd>
        <dt className="text-gray-500">Season</dt><dd className="text-white">{plan.season ?? '—'}</dd>
        <dt className="text-gray-500">New brands</dt><dd className="text-white">{plan.mintManufacturers.length}</dd>
        <dt className="text-gray-500">New models</dt><dd className="text-white">{plan.mintModels.length}</dd>
        <dt className="text-gray-500">Entries new</dt><dd className="text-white">{plan.entries.new}</dd>
        <dt className="text-gray-500">Changed</dt><dd className="text-white">{plan.entries.changed}</dd>
        <dt className="text-gray-500">Unchanged</dt><dd className="text-white">{plan.entries.unchanged}</dd>
        <dt className="text-gray-500">Would lapse</dt><dd className={lapsing ? 'text-amber-300' : 'text-white'}>{lapsing}</dd>
      </dl>
      {plan.mintManufacturers.length > 0 && (
        <p className="text-xs text-gray-400">New brands: {plan.mintManufacturers.join(', ')}</p>
      )}
      {plan.lapsing.map((l) => (
        <div key={l.program.key} className="text-xs">
          <button type="button" onClick={() => setOpenLapse(openLapse === l.program.key ? null : l.program.key)} className="text-amber-300 hover:text-amber-200">
            {l.program.name}: {l.models.length} model{l.models.length === 1 ? '' : 's'} on the {l.fromSeason} list and not this file ({l.toSeason}) {openLapse === l.program.key ? '▾' : '▸'}
          </button>
          {openLapse === l.program.key && (
            <ul className="text-gray-400 pl-3 max-h-48 overflow-y-auto">
              {l.models.map((m, i) => <li key={i}>{m.manufacturer} {m.model}</li>)}
            </ul>
          )}
        </div>
      ))}
      {plan.committed && <p className="text-emerald-400">Imported. Every patrol's item lists now carry the new models.</p>}
    </div>
  );
}

function ImportCard() {
  const qc = useQueryClient();
  const [season, setSeason] = useState(guessSeason());
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<IndemnificationImportPlan | null>(null);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const run = useMutation({
    mutationFn: ({ dryRun }: { dryRun: boolean }) => api.indemnificationAdmin.import(file!, season, dryRun),
    onSuccess: (p, vars) => {
      setPlan(p);
      setError('');
      if (!vars.dryRun) {
        void qc.invalidateQueries({ queryKey: ['admin/indemnification'] });
        void qc.invalidateQueries({ queryKey: ['admin/taxonomy'] });
      }
    },
    onError: (err) => setError(errorText(err)),
  });

  const checked = plan && !plan.committed && plan.errors.length === 0;

  return (
    <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
      <div className="space-y-1">
        <p className="text-sm text-white">Import a season's lists</p>
        <p className="text-xs text-gray-500">
          One CSV per season: <code>program, manufacturer, model, season, status, lines, current_line, non_iso, source, source_ref, note</code>.
          Check first: it says what would be minted, written and left lapsing, and writes nothing. Import writes it in one go.
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-gray-400 space-y-1">
          <span className="block">Season</span>
          <input value={season} onChange={(e) => { setSeason(e.target.value); setPlan(null); }} className="w-28 bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white" placeholder="2025-26" />
        </label>
        <label className="text-xs text-gray-400 space-y-1">
          <span className="block">File</span>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="block text-sm text-gray-300" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPlan(null); setError(''); }} />
        </label>
        <button
          type="button"
          disabled={!file || !/^\d{4}-\d{2}$/.test(season) || run.isPending}
          onClick={() => run.mutate({ dryRun: true })}
          className="px-3 py-1.5 rounded text-sm bg-surface-200 text-gray-200 hover:bg-surface-300 disabled:opacity-40"
        >
          Check
        </button>
        <button
          type="button"
          disabled={!checked || run.isPending}
          onClick={() => run.mutate({ dryRun: false })}
          className="px-3 py-1.5 rounded text-sm bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40"
        >
          Import
        </button>
        {run.isPending && <span className="text-xs text-gray-500">Working…</span>}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {plan && <PlanView plan={plan} />}
    </div>
  );
}

function ProgramRow({ program }: { program: IndemnificationProgram }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(program.notes);
  const [name, setName] = useState(program.name);
  const save = useMutation({
    mutationFn: () => api.indemnificationAdmin.patchProgram(program.key, { name: name.trim(), notes }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['admin/indemnification', 'programs'] }); setOpen(false); },
  });
  return (
    <li className="border-b border-gray-800 last:border-b-0 py-2">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center justify-between gap-3 text-left">
        <span className="text-sm text-white">{program.name}</span>
        <span className="text-xs text-gray-500">
          {program.latestSeason ? `through ${program.latestSeason}` : 'no seasons yet'} · {program.entries} entr{program.entries === 1 ? 'y' : 'ies'}
          {!program.notes && <span className="text-amber-400"> · no notes</span>}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white" aria-label="Program name" />
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={8}
            placeholder="The terms, in a few paragraphs: who is covered, what's excluded, any deadline. Shown with every answer from this program."
            className="w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white placeholder:text-gray-500"
          />
          <div className="flex items-center gap-3">
            <button type="button" disabled={save.isPending || !name.trim()} onClick={() => save.mutate()} className="px-3 py-1.5 rounded text-sm bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40">Save</button>
            {program.updatedBy && <span className="text-xs text-gray-600">Last changed by {program.updatedBy}, {new Date(program.updatedAt).toLocaleString()}</span>}
            {save.isError && <span className="text-xs text-red-400">{errorText(save.error)}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

export default function BindingIndemnificationTab() {
  const programs = useQuery({ queryKey: ['admin/indemnification', 'programs'], queryFn: () => api.indemnificationAdmin.programs() });
  const imports = useQuery({ queryKey: ['admin/indemnification', 'imports'], queryFn: () => api.indemnificationAdmin.imports() });
  const orgs = useQuery({ queryKey: ['admin/indemnification', 'orgs'], queryFn: () => api.indemnificationAdmin.orgs() });

  return (
    <div className="space-y-8 max-w-3xl">
      <div className="space-y-3">
        <h2 className="text-white font-semibold">Bindings</h2>
        <p className="text-xs text-gray-500">
          The indemnified-bindings lists every patrol looks up. Models are minted into the shared item list under
          Bindings › Type › Skis › Manufacturer; rename, retire or merge them in Item Details.
        </p>
        <ImportCard />
      </div>

      <div className="space-y-2">
        <h3 className="text-white font-semibold">Programs</h3>
        {programs.isLoading ? <p className="text-sm text-gray-500">Loading…</p> : (
          <ul className="bg-surface-50 border border-gray-700 rounded-lg px-4">
            {(programs.data ?? []).map((p) => <ProgramRow key={p.key} program={p} />)}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-white font-semibold">Imports</h3>
        {(imports.data ?? []).length === 0 ? <p className="text-sm text-gray-500">None yet.</p> : (
          <ul className="bg-surface-50 border border-gray-700 rounded-lg px-4 text-xs">
            {imports.data!.map((r) => (
              <li key={r.id} className="py-2 border-b border-gray-800 last:border-b-0 flex flex-wrap gap-x-4 gap-y-1">
                <span className="text-white">{r.season}</span>
                <span className="text-gray-400">{new Date(r.createdAt).toLocaleString()}{r.createdBy ? ` · ${r.createdBy}` : ''}</span>
                <span className="text-gray-500">{r.fileName ?? ''}</span>
                <span className="text-gray-500">
                  {Object.entries(r.counts).map(([k, v]) => `${k} ${String(v)}`).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-white font-semibold">Patrols</h3>
        <p className="text-xs text-gray-500">Who has declared NSSRA membership, and so sees the entries from NSSRA's members-only list.</p>
        <ul className="bg-surface-50 border border-gray-700 rounded-lg px-4 text-sm">
          {(orgs.data ?? []).map((o) => (
            <li key={o.orgId} className="py-2 border-b border-gray-800 last:border-b-0 flex items-center justify-between gap-3">
              <span className="text-white">{o.orgName}</span>
              <span className="text-xs text-gray-500">
                {o.nssraMember ? <>Declared{o.setBy ? ` by ${o.setBy}` : ''}{o.setAt ? `, ${new Date(o.setAt).toLocaleDateString()}` : ''}</> : 'Not declared'}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
