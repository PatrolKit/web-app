import { useRef, useState } from 'react';
import type { TelemetryBridgeHistory } from '../../../lib/api.types';
import { duration, kb, resetReason, when } from './telemetryFormat';

/**
 * The three memory figures, in the reference palette's first three categorical
 * slots, dark steps (the app is dark). Those three are validated as a set on
 * every pair, so they stay distinguishable to colour-blind readers too, and the
 * legend and end labels mean colour is never the only cue.
 */
const SERIES = [
  { key: 'free', label: 'Free', short: 'Free', color: '#3987e5' },
  { key: 'minFreeEver', label: 'Lowest since boot', short: 'Lowest', color: '#d95926' },
  { key: 'largestBlock', label: 'Largest block', short: 'Largest', color: '#199e70' },
] as const;

/** Drawn last, so on top: the figure that says how close the bridge came. */
const DRAW_ORDER: SeriesKey[] = ['largestBlock', 'free', 'minFreeEver'];

type SeriesKey = (typeof SERIES)[number]['key'];

const W = 720;
const H = 220;
const PAD = { top: 12, right: 104, bottom: 24, left: 52 };

/**
 * Memory over the range: the lowest of each figure in each bucket, because for
 * memory the low is the news. Reboots are drawn as vertical lines — a crash or
 * power fault in red — since every counter starts again at one.
 */
export function MemoryChart({ history }: { history: TelemetryBridgeHistory }) {
  const { points } = history.memory;
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const start = new Date(points[0]?.at ?? history.generatedAt).getTime();
  const end = new Date(history.generatedAt).getTime();
  const x = (t: number) => PAD.left + ((t - start) / Math.max(1, end - start)) * (W - PAD.left - PAD.right);

  const values = points.flatMap((p) => SERIES.map((s) => p[s.key])).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return <p className="text-sm text-gray-400">No memory reports in this range.</p>;
  }
  const top = niceCeil(Math.max(...values) * 1.1);
  const y = (bytes: number) => PAD.top + (1 - bytes / top) * (H - PAD.top - PAD.bottom);
  const ticks = [0, top / 4, top / 2, (3 * top) / 4, top];

  // A line per series, broken where a bucket had no report rather than drawn
  // across the gap: a gap is "nothing heard", not "memory held steady".
  const paths = SERIES.map((s) => {
    let d = '';
    let pen = false;
    points.forEach((p) => {
      const v = p[s.key];
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(new Date(p.at).getTime()).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return { ...s, d };
  });

  // End labels, nudged apart so two lines ending close together stay legible.
  const ends = SERIES.map((s) => {
    const last = [...points].reverse().find((p) => p[s.key] !== null);
    return last ? { ...s, value: last[s.key] as number, y: y(last[s.key] as number) } : null;
  }).filter((e): e is NonNullable<typeof e> => e !== null).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box) return;
    const at = ((e.clientX - box.left) / box.width) * W;
    const t = start + ((at - PAD.left) / (W - PAD.left - PAD.right)) * (end - start);
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(new Date(p.at).getTime() - t) < Math.abs(new Date(points[best].at).getTime() - t)) best = i;
    });
    setHover(best);
  }

  const hovered = hover === null ? null : points[hover];
  const hoverX = hovered ? x(new Date(hovered.at).getTime()) : 0;

  return (
    <div className="space-y-2">
      <Legend items={SERIES.map((s) => ({ label: s.label, swatch: <span className="inline-block w-3 h-0.5" style={{ background: s.color }} /> }))} />
      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-56 touch-none"
          role="img"
          aria-label="Memory over time"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((b) => (
            <g key={b}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(b)} y2={y(b)} className="stroke-gray-800" />
              <text x={PAD.left - 6} y={y(b) + 3} textAnchor="end" className="fill-gray-500 text-[10px]">
                {(b / 1024).toFixed(0)} KB
              </text>
            </g>
          ))}
          {history.reboots.map((r) => {
            const t = new Date(r.at).getTime();
            if (t < start) return null;
            return (
              <line
                key={r.at}
                x1={x(t)} x2={x(t)} y1={PAD.top} y2={H - PAD.bottom}
                className={r.unplanned ? 'stroke-red-500' : 'stroke-gray-600'}
                strokeDasharray="3 3"
              />
            );
          })}
          {DRAW_ORDER.map((key) => paths.find((p) => p.key === key)!).map((p) => (
            <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth={2} strokeLinejoin="round" />
          ))}
          {ends.map((e) => (
            <text key={e.key} x={W - PAD.right + 6} y={e.y + 3} className="text-[10px]" fill="#d1d5db">
              {e.short} {kb(e.value)}
            </text>
          ))}
          <text x={PAD.left} y={H - 6} className="fill-gray-500 text-[10px]">{when(new Date(start).toISOString())}</text>
          <text x={W - PAD.right} y={H - 6} textAnchor="end" className="fill-gray-500 text-[10px]">now</text>
          {hovered && (
            <g>
              <line x1={hoverX} x2={hoverX} y1={PAD.top} y2={H - PAD.bottom} className="stroke-gray-400" />
              {SERIES.map((s) =>
                hovered[s.key] === null ? null : (
                  <circle key={s.key} cx={hoverX} cy={y(hovered[s.key] as number)} r={4} fill={s.color} className="stroke-surface-50" strokeWidth={2} />
                ),
              )}
            </g>
          )}
        </svg>
        {hovered && (
          <div
            className="absolute top-0 pointer-events-none bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-xs space-y-0.5 shadow-lg"
            style={{
              left: `${(hoverX / W) * 100}%`,
              transform: hoverX > W / 2 ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
            }}
          >
            <p className="text-gray-400">{when(hovered.at)}</p>
            {SERIES.map((s) => (
              <p key={s.key} className="text-gray-200 whitespace-nowrap">
                <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: s.color }} />
                {s.label}: {kb(hovered[s.key as SeriesKey])}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SW = 720;
const SH = 56;
const SPAD = { left: 52, right: 112 };

/**
 * Online and offline across the range, from check-ins, with reboots marked on
 * the same clock. An outage is red; a reboot is a tick above the band — red for
 * a crash or power fault, grey for one somebody asked for.
 */
export function ConnectivityStrip({ history }: { history: TelemetryBridgeHistory }) {
  const start = new Date(history.memory.points[0]?.at ?? history.generatedAt).getTime();
  const end = new Date(history.generatedAt).getTime();
  const x = (t: number) => SPAD.left + ((Math.min(Math.max(t, start), end) - start) / Math.max(1, end - start)) * (SW - SPAD.left - SPAD.right);
  const band = { y: 22, h: 16 };

  return (
    <div className="space-y-2">
      <Legend
        items={[
          { label: 'Checking in', swatch: <span className="inline-block w-3 h-3 rounded-sm bg-gray-700" /> },
          { label: 'Offline', swatch: <span className="inline-block w-3 h-3 rounded-sm bg-red-500" /> },
          { label: 'Unplanned reboot', swatch: <span className="inline-block w-0.5 h-3 bg-red-500" /> },
          { label: 'Reboot', swatch: <span className="inline-block w-0.5 h-3 bg-gray-400" /> },
        ]}
      />
      <svg viewBox={`0 0 ${SW} ${SH}`} className="w-full h-14" role="img" aria-label="Online and offline over time">
        <rect x={SPAD.left} y={band.y} width={SW - SPAD.left - SPAD.right} height={band.h} rx={3} className="fill-gray-700" />
        {history.outages.map((o) => {
          const from = x(new Date(o.startedAt).getTime());
          const to = x(o.endedAt ? new Date(o.endedAt).getTime() : end);
          return (
            <rect key={o.startedAt} x={from} y={band.y} width={Math.max(2, to - from)} height={band.h} className="fill-red-500">
              <title>{`Offline ${duration(o.ms)} from ${when(o.startedAt)}${o.endedAt ? '' : ' — still offline'}`}</title>
            </rect>
          );
        })}
        {history.reboots.map((r) => {
          const t = new Date(r.at).getTime();
          if (t < start) return null;
          return (
            <line key={r.at} x1={x(t)} x2={x(t)} y1={4} y2={band.y - 2} strokeWidth={2} className={r.unplanned ? 'stroke-red-500' : 'stroke-gray-400'}>
              <title>{`${resetReason(r.reason)} at ${when(r.at)}`}</title>
            </line>
          );
        })}
        <text x={SPAD.left} y={SH - 4} className="fill-gray-500 text-[10px]">{when(new Date(start).toISOString())}</text>
        <text x={SW - SPAD.right} y={SH - 4} textAnchor="end" className="fill-gray-500 text-[10px]">now</text>
      </svg>
    </div>
  );
}

function Legend({ items }: { items: { label: string; swatch: React.ReactNode }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">{i.swatch}{i.label}</span>
      ))}
    </div>
  );
}

/** A round top for the axis: 1, 2 or 5 times a power of ten, in bytes. */
function niceCeil(value: number): number {
  if (value <= 0) return 1024;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((m) => m * power >= value)! * power;
  return step;
}
