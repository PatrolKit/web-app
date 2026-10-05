import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

export interface MenuAction {
  key: string;
  label: string;
  onSelect: () => void;
  /** Why it can't be used right now; shown under it, and the item is inert. */
  disabledReason?: string;
}

/**
 * One "Actions" button holding everything a toolbar can do, so the toolbar
 * itself is only for finding things. Opens below, closes on a pick, a click
 * outside or Escape; arrow keys move through the items.
 */
export default function ActionsMenu({ actions, label = 'Actions', align = 'left' }: {
  actions: MenuAction[];
  label?: string;
  /** Which edge the menu lines up with: the button's left, or its right at a toolbar's end. */
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    // The first usable item takes focus, so the keyboard can carry on.
    items.current.find((b) => b && !b.disabled)?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (actions.length === 0) return null;

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>('[aria-haspopup]')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const usable = items.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled);
    const at = usable.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % usable.length : (at - 1 + usable.length) % usable.length;
    usable[next]?.focus();
  }

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1.5"
      >
        {label}
        <svg aria-hidden="true" viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} fill="currentColor">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} z-20 mt-1 min-w-56 bg-surface-50 border border-gray-700 rounded-lg shadow-lg py-1`}
        >
          {actions.map((a, i) => (
            <button
              key={a.key}
              ref={(el) => { items.current[i] = el; }}
              type="button"
              role="menuitem"
              disabled={!!a.disabledReason}
              onClick={() => { setOpen(false); a.onSelect(); }}
              className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-surface-100 focus:bg-surface-100 focus:outline-none disabled:text-gray-500 disabled:hover:bg-transparent"
            >
              {a.label}
              {a.disabledReason && <span className="block text-xs text-gray-500 mt-0.5 max-w-64">{a.disabledReason}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
