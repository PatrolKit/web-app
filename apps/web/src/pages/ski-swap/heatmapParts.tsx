/**
 * What the dashboard's heat maps share (Plan 46 D5): the grid of days across
 * and hours down, each cell as solid as it's busy, totals along the top and
 * the right, and the Fewer/More key. Check-ins by hour and Sales by hour each
 * give it their own color, numbers and words.
 */

/** Faint for few, solid for many. Square root, so one huge hour doesn't wash out the rest. */
export function opacity(v: number, max: number): number {
  if (!v || !max) return 0;
  return Math.round((0.12 + 0.88 * Math.sqrt(v / max)) * 100) / 100;
}

export function hourLabel(h: number): string {
  if (h === 0) return '12 am';
  if (h < 12) return `${h} am`;
  if (h === 12) return '12 pm';
  return `${h - 12} pm`;
}

export function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface HeatmapGridProps {
  days: string[];
  hours: number[];
  /** The cells' color as "r, g, b"; opacity carries the value. */
  rgb: string;
  value: (date: string, hour: number) => number;
  dayTotal: (date: string) => number;
  hourTotal: (hour: number) => number;
  total: number;
  max: number;
  /** A cell's or a total's text. */
  format: (n: number) => string;
  /** A cell's tooltip. */
  tip: (date: string, hour: number, v: number) => string;
  /** The key's right-hand words: what a cell counts. */
  caption: string;
}

export function HeatmapGrid({ days, hours, rgb, value, dayTotal, hourTotal, total, max, format, tip, caption }: HeatmapGridProps) {
  return (
    <>
      <div className="overflow-x-auto">
        <div
          className="grid gap-[3px] items-center text-xs min-w-max"
          style={{ gridTemplateColumns: `3.25rem repeat(${days.length}, minmax(2.75rem, 1fr)) 2.75rem` }}
        >
          <div />
          {days.map((d) => (
            <div key={d} className="text-center text-[11px] text-gray-500 tabular-nums">{format(dayTotal(d))}</div>
          ))}
          <div className="text-center text-[11px] text-gray-500">all</div>

          {hours.map((h) => (
            <Row key={h}>
              <div className="text-right pr-2 text-[11px] text-gray-500 whitespace-nowrap">{hourLabel(h)}</div>
              {days.map((d) => {
                const v = value(d, h);
                const a = opacity(v, max);
                return (
                  <div key={d} title={tip(d, h, v)}
                    className={`h-7 rounded flex items-center justify-center tabular-nums ${v ? '' : 'bg-surface-100'} ${a > 0.55 ? 'text-white' : 'text-gray-300'}`}
                    style={v ? { backgroundColor: `rgba(${rgb}, ${a})` } : undefined}>
                    {v ? format(v) : ''}
                  </div>
                );
              })}
              <div className="text-center text-[11px] text-gray-500 tabular-nums">{format(hourTotal(h))}</div>
            </Row>
          ))}

          <div />
          {days.map((d) => (
            <div key={d} className="text-center text-[11px] text-gray-500 pt-1 whitespace-nowrap">{dayLabel(d)}</div>
          ))}
          <div className="text-center text-[11px] text-gray-300 pt-1 tabular-nums">{format(total)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3 text-[11px] text-gray-500">
        <span>Fewer</span>
        <span className="flex gap-0.5" aria-hidden="true">
          {[0.12, 0.35, 0.6, 0.85, 1].map((o) => (
            <span key={o} className="w-4 h-2.5 rounded-sm" style={{ backgroundColor: `rgba(${rgb}, ${o})` }} />
          ))}
        </span>
        <span>More</span>
        <span className="ml-auto">{caption}</span>
      </div>
    </>
  );
}

/** A grid row is just its cells: the grid lays them out. */
function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
