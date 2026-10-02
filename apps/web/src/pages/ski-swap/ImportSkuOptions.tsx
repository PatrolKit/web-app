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

/** "3 items imported: 2 on tickets, 1 with a new SKU to print a label for." */
export function importedSummary(created: TicketImportRow[], forWhom?: string): string {
  const generated = created.filter((r) => r.generated).length;
  const tickets = created.length - generated;
  const head = `${created.length} item${created.length === 1 ? '' : 's'} imported${forWhom ? ` for ${forWhom}` : ''}`;
  if (generated === 0) return `${head}.`;
  if (tickets === 0) return `${head}, each with a new SKU to print a label for.`;
  return `${head}: ${tickets} on ticket${tickets === 1 ? '' : 's'}, ${generated} with a new SKU to print a label for.`;
}
