import type { TicketImportRow } from '../../lib/api.types';

/**
 * The upload's "Generate SKUs as needed" switch (Plan 31), shown only when the
 * swap's web isn't tickets-only. Off by default: a file is still read as all
 * tickets unless somebody asks otherwise.
 */
export function GenerateSkusSwitch({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-start gap-3">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
      <span>
        <span className="block text-sm text-white">Generate SKUs as needed</span>
        <span className="block text-gray-500 text-xs mt-0.5">
          Rows without a ticket number get a new SKU, and a label to print. Rows with one are
          still checked against the seller's tickets.
        </span>
      </span>
    </label>
  );
}

/** "2 tickets described; 1 new item, each with a SKU to print a label for." */
export function importedSummary(written: TicketImportRow[], forWhom?: string): string {
  // A ticket row fills in an issued ticket (Plan 38); a row without one is a new item.
  const described = written.filter((r) => r.outcome === 'updated').length;
  const generated = written.filter((r) => r.generated).length;
  const whom = forWhom ? ` for ${forWhom}` : '';
  const parts = [
    described ? `${described} ticket${described === 1 ? '' : 's'} described` : null,
    generated ? `${generated} new item${generated === 1 ? '' : 's'}, each with a SKU to print a label for` : null,
  ].filter(Boolean);
  return `${parts.join('; ') || 'Nothing imported'}${whom}.`;
}

/** Whether an import wrote anything: new items, or tickets filled in. */
export function wroteAny(rows: TicketImportRow[] | undefined | null): boolean {
  return (rows ?? []).some((r) => r.outcome === 'created' || r.outcome === 'updated');
}
