import { useEffect, useMemo, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown as faChevronDownDuo, faChevronRight as faChevronRightDuo, faMagnifyingGlass as faSearchDuo } from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';
import type { BindingLookup, BindingLookupDetail } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import { answerBadge, filterModels } from './bindingsLogic';

/**
 * The Bindings tab (Plan 44): will anyone stand behind these bindings?
 *
 * Search across brand and model, or browse a brand; every row answers with a
 * badge and one line, and opens to the seasons behind it and the program's
 * terms. Anyone in the patrol can read it: the point is a glance at check-in.
 */

const DISCLAIMER_SEASON = (season: string | null) =>
  `From the manufacturers' ${season ?? 'current'} indemnified lists. Indemnification covers authorized dealers who follow the maker's procedures; it isn't cover for the swap. The vendor's tech manual is the last word.`;

/** The badge, shared with the item form. */
export function AnswerBadge({ lookup, size = 'sm' }: { lookup: Pick<BindingLookup, 'answer' | 'season' | 'lastListedSeason' | 'lines' | 'currentLine'>; size?: 'xs' | 'sm' }) {
  const b = answerBadge(lookup);
  return (
    <span className={`inline-flex items-center rounded-full border font-medium whitespace-nowrap ${size === 'xs' ? 'px-1.5 py-0 text-[11px]' : 'px-2 py-0.5 text-xs'} ${b.className}`}>
      {b.label}
    </span>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Lines({ lookup }: { lookup: BindingLookup }) {
  return (
    <span className="flex flex-wrap gap-1">
      {lookup.lines.map((l) => (
        <span key={l} className="px-1.5 py-0 rounded bg-surface-200 text-[11px] text-gray-300 capitalize">{l}</span>
      ))}
      {lookup.nonIso && <span className="px-1.5 py-0 rounded bg-surface-200 text-[11px] text-amber-300">Non-ISO</span>}
    </span>
  );
}

function Detail({ orgId, nodeId }: { orgId: string; nodeId: string }) {
  const { data, isLoading, error } = useQuery<BindingLookupDetail>({
    queryKey: ['indemnification/model', orgId, nodeId],
    queryFn: () => api.skiSwap.indemnification.model(orgId, nodeId),
    staleTime: 5 * 60 * 1000,
  });
  if (isLoading) return <p className="text-xs text-gray-500 py-2">Loading…</p>;
  if (error || !data) return <p className="text-xs text-red-400 py-2">Couldn't load the seasons.</p>;
  return (
    <div className="space-y-3 pb-3 pl-3 border-l border-gray-800">
      {data.entries.length > 0 ? (
        <table className="text-xs text-gray-300">
          <thead>
            <tr className="text-gray-500">
              <th className="text-left font-normal pr-4 py-1">Season</th>
              <th className="text-left font-normal pr-4">Status</th>
              <th className="text-left font-normal pr-4">Lines</th>
              <th className="text-left font-normal pr-4">Source</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e) => (
              <tr key={e.season} className="border-t border-gray-800/60">
                <td className="pr-4 py-1 text-white">{e.season}</td>
                <td className="pr-4">{e.status === 'final_season' ? 'Final season' : 'Listed'}{e.currentLine === false ? ' (older model)' : ''}</td>
                <td className="pr-4 capitalize">{e.lines.join(', ') || 'not stated'}{e.nonIso ? ', non-ISO' : ''}</td>
                <td className="pr-4">{e.source === 'manufacturer' ? 'Maker’s sheet' : 'NSSRA list'}{e.sourceRef ? `, ${e.sourceRef}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-gray-500">
          {data.hiddenEntries > 0
            ? `${data.hiddenEntries} season${data.hiddenEntries === 1 ? '' : 's'} on NSSRA's list, which your patrol hasn't declared access to.`
            : 'No seasons on any list.'}
        </p>
      )}
      {data.note && <p className="text-xs text-amber-300">{data.note}</p>}
      {data.program && (
        <div className="space-y-1">
          <p className="text-xs text-gray-400">{data.program.name}</p>
          {data.programNotes && <p className="text-xs text-gray-500 whitespace-pre-line max-w-2xl">{data.programNotes}</p>}
        </div>
      )}
    </div>
  );
}

function Row({ orgId, lookup, showBrand }: { orgId: string; lookup: BindingLookup; showBrand: boolean }) {
  const [open, setOpen] = useState(false);
  const b = answerBadge(lookup);
  return (
    <li className="border-b border-gray-800 last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center gap-3 py-2 text-left hover:bg-surface-100 px-2 rounded">
        <FontAwesomeIcon icon={open ? faChevronDownDuo : faChevronRightDuo} className="h-3 w-3 text-gray-500 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-white truncate">
            {showBrand && <span className="text-gray-400">{lookup.manufacturer} </span>}
            {lookup.model}
          </span>
          <span className="block text-xs text-gray-500 truncate">{b.line}</span>
        </span>
        <Lines lookup={lookup} />
        <AnswerBadge lookup={lookup} />
      </button>
      {open && <div className="px-2"><Detail orgId={orgId} nodeId={lookup.nodeId} /></div>}
    </li>
  );
}

export default function BindingsPage() {
  const { orgId, perms } = useOutletContext<SkiSwapContext>();
  const [query, setQuery] = useState('');
  const [makerId, setMakerId] = useState<string | null>(null);
  const q = useDebounced(query.trim(), 250);

  const { data: makers, isLoading } = useQuery({
    queryKey: ['indemnification/manufacturers', orgId],
    queryFn: () => api.skiSwap.indemnification.manufacturers(orgId),
    staleTime: 60_000,
  });
  const { data: hits, isFetching: searching } = useQuery({
    queryKey: ['indemnification/search', orgId, q],
    queryFn: () => api.skiSwap.indemnification.search(orgId, q),
    enabled: q.length > 0,
    staleTime: 60_000,
  });
  const { data: models } = useQuery({
    queryKey: ['indemnification/models', orgId, makerId],
    queryFn: () => api.skiSwap.indemnification.models(orgId, makerId!),
    enabled: !!makerId,
    staleTime: 60_000,
  });

  const maker = makers?.manufacturers.find((m) => m.nodeId === makerId) ?? null;
  const browsing = useMemo(() => (models ? filterModels(models, query) : []), [models, query]);
  const list: BindingLookup[] = q ? hits ?? [] : browsing;
  const mode: 'search' | 'browse' | 'idle' = q ? 'search' : makerId ? 'browse' : 'idle';
  const loaded = (makers?.manufacturers.length ?? 0) > 0 && makers?.latestSeason;

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="space-y-1">
        <h2 className="text-white font-semibold">Binding indemnification</h2>
        <p className="text-xs text-gray-500 max-w-3xl">{DISCLAIMER_SEASON(makers?.latestSeason ?? null)}</p>
      </div>

      {makers && !makers.nssraMember && (
        <p className="text-xs text-amber-300 bg-amber-900/20 border border-amber-800 rounded-lg px-3 py-2 max-w-3xl">
          Your patrol hasn't declared NSSRA membership, so only manufacturer-published lists are shown.
          {perms.has('ski_swap:admin') ? (
            <> An administrator can declare it under <Link to="/dashboard/ski-swap/config" className="underline">Administration → Settings</Link>.</>
          ) : (
            <> An administrator can declare it under Administration → Settings.</>
          )}
        </p>
      )}

      <div className="relative max-w-xl">
        <FontAwesomeIcon icon={faSearchDuo} className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
        <input
          className="w-full bg-surface-100 border border-gray-700 rounded-lg pl-9 pr-3 py-2 text-base text-white placeholder:text-gray-500 focus:border-brand-600 focus:outline-none"
          placeholder="Search a brand or model: griffon 13, look pivot, attack"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search bindings"
        />
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !loaded ? (
        <p className="text-sm text-gray-500">No lists loaded yet.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[14rem_1fr] gap-6">
          <aside className="space-y-1">
            <p className="text-xs text-gray-500 px-2">Brands</p>
            <ul className="max-h-[70vh] overflow-y-auto">
              {makers!.manufacturers.map((m) => (
                <li key={m.nodeId}>
                  <button
                    type="button"
                    onClick={() => { setMakerId(m.nodeId === makerId ? null : m.nodeId); }}
                    className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm text-left ${m.nodeId === makerId ? 'bg-surface-100 text-white' : 'text-gray-300 hover:bg-surface-100'}`}
                  >
                    <span className="truncate">{m.label}</span>
                    <span className="text-xs text-gray-500 shrink-0">{m.listed}/{m.models}</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-600 px-2">listed / models</p>
          </aside>

          <section className="min-w-0">
            {mode === 'idle' && (
              <p className="text-sm text-gray-500">Type a brand or model, or pick a brand.</p>
            )}
            {mode === 'search' && (
              <p className="text-xs text-gray-500 mb-1">
                {searching ? 'Searching…' : `${list.length === 50 ? '50+' : list.length} match${list.length === 1 ? '' : 'es'}`}
              </p>
            )}
            {mode === 'browse' && maker && (
              <p className="text-xs text-gray-500 mb-1">
                {maker.label}: {maker.models} model{maker.models === 1 ? '' : 's'}
                {maker.programs.length > 0 && <> · {maker.programs.map((p) => p.name).join(', ')}</>}
              </p>
            )}
            {mode !== 'idle' && list.length === 0 && !searching && (
              <p className="text-sm text-gray-500">Nothing matches.</p>
            )}
            <ul>
              {list.map((l) => (
                <Row key={l.nodeId} orgId={orgId} lookup={l} showBrand={mode === 'search'} />
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
