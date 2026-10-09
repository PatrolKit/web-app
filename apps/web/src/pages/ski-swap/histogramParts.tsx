import type { Bin } from './histogram';

/** The tallest bar, in pixels: the card stays short, like Items by category. */
const BAR_MAX = 80;

/**
 * A histogram's bars: one per range, its count on top and the range under
 * it. Shared by the seller and buyer cards, which give it their color and
 * what a bar counts.
 */
export function HistogramBars({ bins, barClass, noun }: {
  bins: Bin[];
  /** The bars' fill, a Tailwind background class. */
  barClass: string;
  /** What a bar counts, for its tooltip: "sellers", "checkouts". */
  noun: string;
}) {
  const max = Math.max(1, ...bins.map((b) => b.count));
  const fmt = (n: number) => n.toLocaleString('en-US');
  return (
    <div className="overflow-x-auto">
      {/* Bars side by side, centered: spare width goes to the edges, not
          between the bars. Too wide for the card, it scrolls instead. */}
      <div className="flex items-end gap-1.5 w-max mx-auto">
        {bins.map((b) => (
          <div key={b.label} className="w-12 shrink-0 flex flex-col items-center" title={`${fmt(b.count)} ${noun}: ${b.label}`}>
            <span className={`text-[11px] tabular-nums ${b.count ? 'text-gray-200' : 'text-gray-600'}`}>{fmt(b.count)}</span>
            <div className={`w-full mt-1 rounded-t ${b.count ? barClass : 'bg-surface-100'}`}
              style={{ height: `${b.count ? Math.max(3, Math.round((b.count / max) * BAR_MAX)) : 2}px` }} />
            <span className="text-[10px] text-gray-400 text-center leading-tight mt-1.5 whitespace-nowrap">{b.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A row of mutually exclusive choices, in the card's color, as the heat maps' toggles are. */
export function Toggle<T extends string>({ value, options, onChange, activeClass, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  activeClass: string;
  label: string;
}) {
  return (
    <div className="flex rounded border border-gray-700 overflow-hidden text-xs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={`px-3 py-1 whitespace-nowrap ${value === o.value ? `${activeClass} text-white` : 'text-gray-400 hover:text-gray-200'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
