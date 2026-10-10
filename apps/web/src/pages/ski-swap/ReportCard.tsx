import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Side } from './salesCheckView';

/**
 * The Reports tab's cards (Plan 48), shared by Sales check and Catalog check:
 * one side of a comparison as labelled fields with its links, and the
 * tombstone a decided card leaves in its place.
 */

/** Where a decided sale was: says what was done, and settles in so the change is seen. */
export function Tombstone({ text, hint = 'Undo it under Decided.', settle = true }: { text: string; hint?: string; settle?: boolean }) {
  return (
    <div role="status" className={`${settle ? 'animate-settle' : 'bg-green-500/5'} flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-green-800/60 px-3 py-2.5 text-sm`}>
      <span className="text-green-400">✓</span>
      <span className="text-green-200 min-w-0 break-words">{text}</span>
      {hint && <span className="ml-auto text-xs text-gray-500">{hint}</span>}
    </div>
  );
}

export function SidePanel({ side, icon, className = '', action }: { side: Side; icon: string; className?: string; action?: ReactNode }) {
  return (
    <div className={`p-3 min-w-0 flex flex-col ${className}`}>
      <p className="text-[11px] uppercase tracking-wide text-gray-500 mb-1.5">{icon} {side.title}</p>
      {side.empty ? <p className="text-xs text-gray-400">{side.empty}</p> : (
        <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 text-sm">
          {side.fields.map((f) => (
            <Fragment key={f.label}>
              <dt className="text-xs text-gray-500 pt-0.5">{f.label}</dt>
              <dd className={`min-w-0 break-words ${f.mono ? 'font-mono' : ''} ${f.warn ? 'text-amber-400' : 'text-gray-200'}`}>
                {f.value}
                {f.tag && <span className="ml-1.5 inline-block whitespace-nowrap text-[11px] bg-amber-900/40 text-amber-300 rounded px-1.5 py-px font-sans">{f.tag}</span>}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {side.links.length > 0 && (
        <p className="mt-2 flex gap-3 text-xs">
          {side.links.map((l) => 'href' in l
            ? <a key={l.label} href={l.href} target="_blank" rel="noreferrer" className="text-brand-500 hover:underline">{l.label} ↗</a>
            : <Link key={l.label} to={l.to} className="text-brand-500 hover:underline">{l.label} ›</Link>)}
        </p>
      )}
      {/* Pinned to the bottom, so side-by-side panels' buttons line up. */}
      {action && <div className="mt-auto pt-2.5">{action}</div>}
    </div>
  );
}
