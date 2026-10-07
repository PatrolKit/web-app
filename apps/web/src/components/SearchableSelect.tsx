import { useEffect, useMemo, useRef, useState } from 'react';

export interface SearchableSelectOption {
  value: string;
  label: string;
  /** Secondary text shown next to the label (e.g. phone number). */
  sublabel?: string;
  /** Extra text to match against while searching (e.g. email). */
  keywords?: string;
}

export interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  clearLabel?: string;
  emptyMessage?: string;
  /** Cap on rendered rows — keeps hundreds of options from bogging the list down. */
  maxVisible?: number;
  disabled?: boolean;
  className?: string;
  /** The field's look, for a filter bar that's denser than a form. */
  inputClassName?: string;
  /** Names the field for assistive tech when there's no visible label. */
  ariaLabel?: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9@.]/g, '');
}

export default function SearchableSelect({
  value, onChange, options,
  placeholder = 'Select…',
  clearLabel = 'None',
  emptyMessage = 'No matches.',
  maxVisible = 100,
  disabled = false,
  className = '',
  inputClassName = 'bg-surface-100 px-3 py-2',
  ariaLabel,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const searchable = useMemo(
    () => options.map((o) => ({ option: o, haystack: normalize(`${o.label} ${o.sublabel ?? ''} ${o.keywords ?? ''}`) })),
    [options],
  );

  const filtered = useMemo(() => {
    const needle = normalize(search);
    if (!needle) return options.slice(0, maxVisible);
    return searchable.filter((s) => s.haystack.includes(needle)).slice(0, maxVisible).map((s) => s.option);
  }, [search, options, searchable, maxVisible]);

  const totalMatches = useMemo(() => {
    const needle = normalize(search);
    if (!needle) return options.length;
    return searchable.reduce((n, s) => (s.haystack.includes(needle) ? n + 1 : n), 0);
  }, [search, options, searchable]);

  const rowCount = filtered.length + 1; // +1 for the clear/none row

  useEffect(() => { setHighlight(0); }, [search, open]);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  function openList() {
    if (disabled) return;
    setSearch('');
    setOpen(true);
  }

  function commit(next: string) {
    onChange(next);
    setOpen(false);
    setSearch('');
  }

  function selectRow(index: number) {
    if (index === 0) { commit(''); return; }
    const option = filtered[index - 1];
    if (option) commit(option.value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { openList(); return; }
      setHighlight((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + rowCount) % rowCount);
      return;
    }
    if (e.key === 'Enter') {
      if (open) { e.preventDefault(); selectRow(highlight); }
      return;
    }
    if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setSearch(''); }
      return;
    }
    if (e.key === 'Tab' && open) setOpen(false);
  }

  const displayValue = open
    ? search
    : selected
      ? `${selected.label}${selected.sublabel ? ` (${selected.sublabel})` : ''}`
      : '';

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        value={displayValue}
        placeholder={open ? 'Type to search…' : placeholder}
        onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
        onFocus={openList}
        onMouseDown={() => { if (!open) openList(); }}
        onKeyDown={handleKeyDown}
        className={`w-full ${inputClassName} border border-gray-700 rounded pr-8 text-sm text-white placeholder-gray-500 disabled:opacity-50`}
      />

      {selected && !open ? (
        <button
          type="button"
          aria-label="Clear selection"
          onClick={() => commit('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white text-sm leading-none px-1"
        >×</button>
      ) : (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-[10px] pointer-events-none">▾</span>
      )}

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto bg-surface-200 border border-gray-700 rounded shadow-lg py-1 text-sm"
        >
          <li
            role="option"
            aria-selected={value === ''}
            data-highlighted={highlight === 0}
            onMouseEnter={() => setHighlight(0)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => selectRow(0)}
            className={`px-3 py-1.5 cursor-pointer text-gray-400 ${highlight === 0 ? 'bg-surface-100 text-white' : ''}`}
          >
            {clearLabel}
          </li>

          {filtered.length === 0 && (
            <li className="px-3 py-2 text-gray-500">{emptyMessage}</li>
          )}

          {filtered.map((o, i) => {
            const rowIndex = i + 1;
            return (
              <li
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                data-highlighted={highlight === rowIndex}
                onMouseEnter={() => setHighlight(rowIndex)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectRow(rowIndex)}
                className={`px-3 py-1.5 cursor-pointer flex items-baseline justify-between gap-2 ${
                  highlight === rowIndex ? 'bg-surface-100' : ''
                } ${o.value === value ? 'text-brand-400' : 'text-white'}`}
              >
                <span className="truncate">{o.label}</span>
                {o.sublabel && <span className="text-xs text-gray-500 shrink-0">{o.sublabel}</span>}
              </li>
            );
          })}

          {totalMatches > filtered.length && (
            <li className="px-3 py-1.5 text-xs text-gray-500 border-t border-gray-800">
              Showing {filtered.length} of {totalMatches} — keep typing to narrow.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
