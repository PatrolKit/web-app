import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import type {
  TelemetryBridge, TelemetryBridgeHistory, TelemetryFleet, TelemetryRange,
} from '../../../lib/api.types';
import { ConnectivityStrip, MemoryChart } from './telemetryCharts';
import { RANGES, ago, duration, kb, resetReason, when } from './telemetryFormat';

/**
 * Print bridge telemetry. With no bridge picked, the fleet: which bridges are
 * rebooting, dropping off, or running low on memory. With one picked, its
 * history. The pick lives in the URL, so a bridge's page can be linked to.
 */
export default function PrintBridgeTelemetry() {
  const [params, setParams] = useSearchParams();
  const bridgeId = params.get('bridge');
  const [range, setRange] = useState<TelemetryRange>('7d');

  const { data: bridges = [] } = useQuery({
    queryKey: ['admin-telemetry-bridges'],
    queryFn: () => api.admin.telemetryBridges(),
    refetchInterval: 60_000,
  });

  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('bridge', id); else next.delete('bridge');
    setParams(next);
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <BridgePicker bridges={bridges} value={bridgeId} onChange={select} />
        <div className="inline-flex gap-1 p-1 bg-surface-100 rounded-lg" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.value}
              type="button"
              aria-pressed={range === r.value}
              onClick={() => setRange(r.value)}
              className={[
                'px-3 py-1 rounded-md text-sm',
                range === r.value ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
              ].join(' ')}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {bridgeId ? <BridgeView deviceId={bridgeId} range={range} /> : <FleetView range={range} onSelect={select} />}
    </section>
  );
}

// ─── The picker ──────────────────────────────────────────────────────────────

function BridgePicker({
  bridges, value, onChange,
}: { bridges: TelemetryBridge[]; value: string | null; onChange: (id: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const selected = bridges.find((b) => b.id === value) ?? null;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bridges;
    return bridges.filter((b) =>
      [b.name, b.org.name, b.station ?? '', b.clientId].some((field) => field.toLowerCase().includes(q)),
    );
  }, [bridges, query]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
    setQuery('');
  };

  // Row 0 is "All print bridges"; the matches follow it.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, matches.length)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active === 0 ? null : matches[active - 1]?.id ?? null); }
    else if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={root} className="relative w-full sm:w-80">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setActive(0); }}
        className="w-full flex items-center justify-between gap-2 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-left"
      >
        <span className="truncate text-white">
          {selected ? `${selected.name} · ${selected.org.name}` : 'All print bridges'}
        </span>
        <span className="text-gray-500" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-surface-100 border border-gray-700 rounded shadow-lg">
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKey}
            placeholder="Search name, org, station or client id"
            className="w-full bg-surface-50 border-b border-gray-700 px-3 py-2 text-sm text-white outline-none"
          />
          <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
            <PickerRow active={active === 0} onPick={() => choose(null)} onHover={() => setActive(0)}>
              <span className="text-gray-300">All print bridges</span>
            </PickerRow>
            {matches.map((b, i) => (
              <PickerRow key={b.id} active={active === i + 1} onPick={() => choose(b.id)} onHover={() => setActive(i + 1)}>
                <span className="flex items-center gap-2 min-w-0">
                  <OnlineDot online={b.online} />
                  <span className="truncate text-white">{b.name}</span>
                </span>
                <span className="block text-xs text-gray-500 truncate pl-4">
                  {b.org.name}{b.station ? ` · ${b.station}` : ' · no station'}
                </span>
              </PickerRow>
            ))}
            {matches.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">No bridge matches that.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

function PickerRow({
  active, onPick, onHover, children,
}: { active: boolean; onPick: () => void; onHover: () => void; children: React.ReactNode }) {
  return (
    <li
      role="option"
      aria-selected={active}
      onMouseDown={(e) => { e.preventDefault(); onPick(); }}
      onMouseEnter={onHover}
      className={`px-3 py-1.5 cursor-pointer text-sm ${active ? 'bg-surface-200' : ''}`}
    >
      {children}
    </li>
  );
}

// ─── The fleet ───────────────────────────────────────────────────────────────

function FleetView({ range, onSelect }: { range: TelemetryRange; onSelect: (id: string) => void }) {
  const { data, isLoading, error } = useQuery<TelemetryFleet>({
    queryKey: ['admin-telemetry-fleet', range],
    queryFn: () => api.admin.telemetryFleet(range),
    refetchInterval: 60_000,
  });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;
  if (error || !data) return <p className="text-red-400 text-sm">{(error as Error)?.message ?? 'Could not load telemetry'}</p>;
  if (data.bridges.length === 0) {
    return <p className="text-sm text-gray-400 bg-surface-50 rounded-lg p-4">There are no print bridges yet.</p>;
  }

  // Worst first: crashes, then time offline, then the lowest memory.
  const rows = [...data.bridges].sort((a, b) =>
    b.unplannedReboots - a.unplannedReboots ||
    b.disconnectedMs - a.disconnectedMs ||
    (a.lowestMemory ?? Infinity) - (b.lowestMemory ?? Infinity));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile label="Online now" value={`${data.totals.online} of ${data.totals.bridges}`} note={`${data.totals.reporting} sent telemetry in this range`} />
        <Tile
          label="Unplanned reboots"
          value={String(data.totals.unplannedReboots)}
          tone={data.totals.unplannedReboots > 0 ? 'bad' : undefined}
          note={`${data.totals.reboots} ${data.totals.reboots === 1 ? 'reboot' : 'reboots'} in all`}
        />
        <Tile label="Time offline" value={duration(data.totals.disconnectedMs)} note="All bridges, added together" />
        <Tile label="Lowest memory" value={kb(data.totals.lowestMemory)} note="The lowest any bridge reached" />
      </div>

      <div className="bg-surface-50 rounded-lg overflow-x-auto">
        <table className="w-full text-sm min-w-[52rem]">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-gray-800">
              <th className="px-4 py-2 font-normal">Bridge</th>
              <th className="px-4 py-2 font-normal">Status</th>
              <th className="px-4 py-2 font-normal">Firmware</th>
              <th className="px-4 py-2 font-normal text-right">Reboots</th>
              <th className="px-4 py-2 font-normal text-right">Offline</th>
              <th className="px-4 py-2 font-normal text-right">Lowest memory</th>
              <th className="px-4 py-2 font-normal text-right">Signal</th>
              <th className="px-4 py-2 font-normal">Last report</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr
                key={b.id}
                onClick={() => onSelect(b.id)}
                className="border-b border-gray-800 last:border-0 cursor-pointer hover:bg-surface-100/60"
              >
                <td className="px-4 py-3">
                  <p className="text-white">{b.name}</p>
                  <p className="text-xs text-gray-500">{b.org.name}{b.station ? ` · ${b.station}` : ' · no station'}</p>
                </td>
                <td className="px-4 py-3"><Status bridge={b} /></td>
                <td className="px-4 py-3 text-gray-400">
                  <p>{b.latest?.firmwareVersion ?? '—'}</p>
                  <p className="text-xs text-gray-500">{b.latest?.board ?? ''}</p>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  <p className="text-gray-300">{b.reboots || '—'}</p>
                  {b.unplannedReboots > 0 && (
                    <p className="text-xs text-red-400 font-semibold whitespace-nowrap">{b.unplannedReboots} unplanned</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                  {b.disconnectedMs ? duration(b.disconnectedMs) : '—'}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-300">{kb(b.lowestMemory)}</td>
                <td className="px-4 py-3 text-right tabular-nums text-gray-400">
                  {b.latest?.wifiRssi != null ? `${b.latest.wifiRssi} dBm` : '—'}
                </td>
                <td className="px-4 py-3 text-gray-400">{b.latest ? ago(b.latest.receivedAt) : 'never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <Panel title="Firmware in use">
          {data.firmware.length === 0 ? (
            <p className="text-sm text-gray-500">No bridge has reported its firmware yet.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.firmware.map((f) => (
                <li key={f.version} className="flex justify-between gap-3">
                  <span className="text-gray-300 font-mono">{f.version}</span>
                  <span className="text-gray-400 tabular-nums">{f.bridges} {f.bridges === 1 ? 'bridge' : 'bridges'}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Why bridges rebooted">
          {data.resetReasons.length === 0 ? (
            <p className="text-sm text-gray-500">No reboots in this range.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {data.resetReasons.map((r) => (
                <li key={r.reason} className="flex justify-between gap-3">
                  <span className={r.unplanned ? 'text-red-400' : 'text-gray-300'}>{resetReason(r.reason)}</span>
                  <span className="text-gray-400 tabular-nums">{r.reboots}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ─── One bridge ──────────────────────────────────────────────────────────────

const INTERVALS = [
  { value: null, label: 'Default (5 min)' },
  { value: 60, label: 'Every minute' },
  { value: 900, label: 'Every 15 min' },
  { value: 3600, label: 'Every hour' },
] as const;

function BridgeView({ deviceId, range }: { deviceId: string; range: TelemetryRange }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery<TelemetryBridgeHistory>({
    queryKey: ['admin-telemetry-bridge', deviceId, range],
    queryFn: () => api.admin.telemetryBridge(deviceId, range),
    refetchInterval: 60_000,
  });
  const interval = useMutation({
    mutationFn: (s: number | null) => api.admin.setTelemetryInterval(deviceId, s),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-telemetry-bridge', deviceId] }),
  });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;
  if (error || !data) return <p className="text-red-400 text-sm">{(error as Error)?.message ?? 'Could not load this bridge'}</p>;

  const { bridge, latest, totals } = data;
  const intervalValue = bridge.intervalIsDefault ? null : bridge.intervalS;

  return (
    <div className="space-y-4">
      <div className="bg-surface-50 rounded-lg p-4 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <p className="text-white font-medium">{bridge.name}</p>
          <p className="text-xs text-gray-500">
            {bridge.org.name}{bridge.station ? ` · ${bridge.station}` : ' · no station'} · <span className="font-mono">{bridge.clientId}</span>
          </p>
          <Status bridge={bridge} />
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <dt className="text-gray-500">Firmware</dt>
          <dd className="text-gray-300 font-mono">{latest?.firmwareVersion ?? '—'}</dd>
          <dt className="text-gray-500">Board</dt>
          <dd className="text-gray-300">{latest?.board ?? '—'}{latest?.psram === false ? ', no PSRAM' : latest?.psram ? ', PSRAM' : ''}</dd>
          <dt className="text-gray-500">Booted</dt>
          <dd className="text-gray-300">{latest?.bootAt ? `${when(latest.bootAt)} — ${resetReason(latest.resetReason)}` : '—'}</dd>
          <dt className="text-gray-500">Boots in all</dt>
          <dd className="text-gray-300 tabular-nums">{latest?.bootCount ?? '—'}</dd>
        </dl>
        <label className="text-sm space-y-1">
          <span className="block text-gray-500">Reports</span>
          <select
            value={intervalValue === null ? '' : String(intervalValue)}
            disabled={interval.isPending}
            onChange={(e) => interval.mutate(e.target.value === '' ? null : Number(e.target.value))}
            className="bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-white"
          >
            {INTERVALS.map((i) => (
              <option key={i.label} value={i.value === null ? '' : String(i.value)}>{i.label}</option>
            ))}
          </select>
          <span className="block text-xs text-gray-500">Takes effect at the bridge’s next report.</span>
        </label>
      </div>

      {!latest && (
        <p className="text-sm text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded-lg p-3">
          This bridge hasn’t sent any telemetry yet. That needs firmware with telemetry reporting;
          the time offline below is measured from its check-ins, which every bridge makes.
        </p>
      )}
      {latest?.malformedFields && latest.malformedFields.length > 0 && (
        <p className="text-sm text-amber-300 bg-amber-950/30 border border-amber-900/50 rounded-lg p-3">
          Its latest report sent {latest.malformedFields.join(', ')} with the wrong type. The report was kept as sent; those fields are left out of the figures.
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Tile
          label="Unplanned reboots"
          value={String(totals.unplannedReboots)}
          tone={totals.unplannedReboots > 0 ? 'bad' : undefined}
          note={`${totals.reboots} ${totals.reboots === 1 ? 'reboot' : 'reboots'} in all`}
        />
        <Tile label="Time offline" value={duration(totals.disconnectedMs)} note={`${totals.outages} ${totals.outages === 1 ? 'outage' : 'outages'}`} />
        <Tile label="Lowest memory" value={kb(totals.lowestMemory)} note="Lowest since boot, in any report" />
        <Tile label="Latest memory" value={kb(latest?.memFree)} note={`Largest block ${kb(latest?.memLargestBlock)}, in the latest report`} />
      </div>

      <Panel title="Memory">
        <MemoryChart history={data} />
      </Panel>

      <Panel title="Connection">
        <ConnectivityStrip history={data} />
      </Panel>

      <div className="grid lg:grid-cols-2 gap-3">
        <Panel title="Reboots">
          {data.reboots.length === 0 ? (
            <p className="text-sm text-gray-500">No reboots in this range.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.reboots.map((r) => (
                  <tr key={r.at} className="border-b border-gray-800 last:border-0">
                    <td className="py-1.5 text-gray-400 whitespace-nowrap">{when(r.at)}</td>
                    <td className={`py-1.5 px-3 ${r.unplanned ? 'text-red-400 font-medium' : 'text-gray-300'}`}>
                      {r.unplanned && <span aria-hidden>⚠ </span>}{resetReason(r.reason)}
                      {r.missed > 0 && (
                        <span className="block text-xs text-gray-500">
                          and {r.missed} more {r.missed === 1 ? 'boot' : 'boots'} before this one that never reported
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right text-xs text-gray-500 font-mono">{r.firmwareVersion ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Outages">
          {data.outages.length === 0 ? (
            <p className="text-sm text-gray-500">No outages in this range.</p>
          ) : (
            <table className="w-full text-sm">
              <tbody>
                {data.outages.map((o) => (
                  <tr key={o.startedAt} className="border-b border-gray-800 last:border-0">
                    <td className="py-1.5 text-gray-400 whitespace-nowrap">{when(o.startedAt)}</td>
                    <td className="py-1.5 px-3 text-gray-300">
                      {o.endedAt ? `back ${when(o.endedAt)}` : <span className="text-red-400">still offline</span>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-gray-300">{duration(o.ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {latest && (
        <details className="bg-surface-50 rounded-lg p-4 text-sm">
          <summary className="cursor-pointer text-gray-300">Latest report, as sent — {when(latest.receivedAt)}</summary>
          <pre className="mt-3 text-xs text-gray-400 overflow-x-auto">{JSON.stringify(latest.body, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'bad' }) {
  return (
    <div className="bg-surface-50 rounded-lg p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${tone === 'bad' ? 'text-red-400' : 'text-white'}`}>{value}</p>
      {note && <p className="text-xs text-gray-500 mt-0.5">{note}</p>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface-50 rounded-lg p-4 space-y-3">
      <h3 className="text-sm text-gray-300 font-medium">{title}</h3>
      {children}
    </div>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${online ? 'bg-emerald-500' : 'bg-gray-600'}`} aria-hidden />;
}

function Status({ bridge }: { bridge: TelemetryBridge }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      <OnlineDot online={bridge.online} />
      <span className={bridge.online ? 'text-emerald-400' : 'text-gray-400'}>
        {bridge.online ? 'Online' : bridge.lastSeenAt ? `Offline, last seen ${ago(bridge.lastSeenAt)}` : 'Never seen'}
      </span>
    </span>
  );
}
