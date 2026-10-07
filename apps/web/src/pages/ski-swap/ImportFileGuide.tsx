import { useState } from 'react';
import type { ImportGuideFile } from '../../lib/api.types';

const SEEN_KEY = 'importFileGuide.seen';

function seen(): boolean {
  try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

/** Collapses the guide for the rest of the session, once someone has uploaded a file. */
export function markImportGuideSeen(): void {
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch { /* shown again next time */ }
}

const DOWNLOADS: { file: ImportGuideFile; label: string; saveAs: string }[] = [
  { file: 'template.csv', label: 'Template', saveAs: 'items-template.csv' },
  { file: 'example.csv', label: 'Example', saveAs: 'items-example.csv' },
  { file: 'details.csv', label: 'Categories and details', saveAs: 'categories-and-details.csv' },
];

function save(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the save in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/**
 * What an item file should hold, and three downloads to start from (Plan 42
 * D11, D12): a template of headers, an example, and every category and
 * detail as the import spells them. Shared by staff's upload and a shop's own.
 */
export default function ImportFileGuide({
  download,
  allowGenerate,
}: {
  download: (file: ImportGuideFile) => Promise<Blob>;
  /** Rows may go without a ticket when SKUs are generated (Plan 31). */
  allowGenerate: boolean;
}) {
  const [open, setOpen] = useState(() => !seen());
  const [fetching, setFetching] = useState<ImportGuideFile | null>(null);
  const [error, setError] = useState('');

  async function get(d: (typeof DOWNLOADS)[number]) {
    setFetching(d.file);
    setError('');
    try {
      save(await download(d.file), d.saveAs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download that file');
    } finally {
      setFetching(null);
    }
  }

  const term = 'text-gray-200 font-medium';
  return (
    <div className="text-sm text-gray-400 space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-xs text-gray-400 uppercase tracking-wider hover:text-white"
      >
        {open ? '▾' : '▸'} What goes in the file
      </button>
      {open && (
        <div className="space-y-2">
          <p>One row per item, with a header row. Column names can be in any case.</p>
          <ul className="space-y-1 list-disc pl-5">
            <li><span className={term}>ticket</span>: the number on the ticket, digits only. Required{allowGenerate ? ', unless you generate SKUs' : ''}.</li>
            <li><span className={term}>name</span>: what the tag says. Kept as you wrote it.</li>
            <li><span className={term}>price</span>: in dollars, like 45 or 19.50. Can be blank for a ticket.</li>
            <li><span className={term}>description</span>: notes buyers see under the name.</li>
            <li><span className={term}>category</span>: one of our categories, like Ski boots.</li>
            <li>
              <span className={term}>details</span>: one column per detail, headed with its name (Manufacturer, Size,
              Color…), one value per cell, spelled as in our lists. A detail only counts for a category that has it.
            </li>
          </ul>
          <p>
            Leave a cell blank to skip it. Put quotes around anything with a comma in it. Columns we don’t use are
            ignored. A category or value we don’t know stops the upload and is listed; you can fix the file, or
            import anyway without them.
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-xs text-gray-500">Download:</span>
        {DOWNLOADS.map((d) => (
          <button
            key={d.file}
            type="button"
            onClick={() => get(d)}
            disabled={fetching !== null}
            className="text-sm text-brand-500 hover:underline disabled:opacity-50"
          >
            {fetching === d.file ? 'Downloading…' : d.label}
          </button>
        ))}
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
