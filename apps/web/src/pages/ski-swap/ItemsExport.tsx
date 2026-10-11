import { useState } from 'react';
import { faEnvelope as faEnvelopeDuo, faFileArrowDown as faFileArrowDownDuo } from '@fortawesome/pro-duotone-svg-icons';
import ActionsMenu from '../../components/ActionsMenu';
import { api, ApiError } from '../../lib/api';
import { saveFile } from '../../lib/saveFile';
import type { ItemListView } from '../../lib/api.types';

/** The Items page's filters, as the export takes them. */
export type ExportFilters = { query?: string; sellerId?: string } & ItemListView;

const input = 'w-full bg-surface-100 border border-gray-700 focus:border-brand-500 rounded px-3 py-2 text-sm text-white';

/**
 * The Items page's Export menu: every item matching the filters on screen (not
 * one page), as a spreadsheet to download or email. The server reads sales
 * fresh from Square for it, which can take a little while.
 */
export default function ItemsExport({ orgId, swapId, filters, defaultEmail }: {
  orgId: string; swapId: string; filters: ExportFilters; defaultEmail: string;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [emailing, setEmailing] = useState(false);

  async function download() {
    setBusy(true); setNote(null);
    try {
      const { blob, filename } = await api.skiSwap.exportItems(orgId, swapId, filters);
      saveFile(blob, filename);
      setNote({ tone: 'ok', text: 'Downloaded.' });
    } catch (err) {
      setNote({ tone: 'error', text: err instanceof Error ? err.message : 'The spreadsheet couldn’t be made. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {busy && <span className="text-xs text-gray-400 flex items-center gap-1.5"><span className="h-3 w-3 rounded-full border-2 border-brand-400 border-t-transparent animate-spin" aria-hidden="true" />Reading sales from Square…</span>}
      {!busy && note && <span className={`text-xs ${note.tone === 'ok' ? 'text-green-400' : 'text-red-400'}`}>{note.text}</span>}
      <ActionsMenu label="Export" align="right" actions={[
        { key: 'download', label: 'Download spreadsheet', icon: faFileArrowDownDuo, onSelect: () => void download(), disabledReason: busy ? 'Already making one.' : undefined },
        { key: 'email', label: 'Email spreadsheet…', icon: faEnvelopeDuo, onSelect: () => { setNote(null); setEmailing(true); }, disabledReason: busy ? 'Already making one.' : undefined },
      ]} />
      {emailing && (
        <EmailExport orgId={orgId} swapId={swapId} filters={filters} defaultEmail={defaultEmail}
          onClose={() => setEmailing(false)}
          onSent={(r) => { setEmailing(false); setNote({ tone: 'ok', text: `Emailed ${r.items.toLocaleString('en-US')} item${r.items === 1 ? '' : 's'} to ${r.to}.` }); }} />
      )}
    </div>
  );
}

function EmailExport({ orgId, swapId, filters, defaultEmail, onClose, onSent }: {
  orgId: string; swapId: string; filters: ExportFilters; defaultEmail: string;
  onClose: () => void; onSent: (r: { to: string; items: number }) => void;
}) {
  const [to, setTo] = useState(defaultEmail);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim());
  const close = () => { if (!sending) onClose(); };

  async function send() {
    setSending(true); setError(null);
    try {
      const r = await api.skiSwap.emailItemsExport(orgId, swapId, {
        to: to.trim(),
        ...(filters.query ? { query: filters.query } : {}),
        ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.printed !== undefined ? { printed: filters.printed ? 'true' as const : 'false' as const } : {}),
        ...(filters.sort ? { sort: filters.sort, dir: filters.dir ?? 'asc' } : {}),
      });
      onSent(r);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'It wasn’t sent. Try again.');
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 pt-[10vh] z-50" onClick={close}>
      <div role="dialog" aria-modal="true" aria-label="Email spreadsheet" onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-md p-5 space-y-4">
        <div>
          <h3 className="text-white font-medium">Email spreadsheet</h3>
          <p className="text-xs text-gray-400 mt-1">
            Every item matching the filters on screen, with sales read from Square now. It includes sellers’ phone numbers and email addresses.
          </p>
        </div>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && !sending) void send(); }}>
          <label className="block text-xs text-gray-400" htmlFor="export-to">Send to</label>
          <input id="export-to" type="email" autoFocus value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" className={input} />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={close} disabled={sending} className="bg-surface-100 hover:bg-surface-200 disabled:opacity-40 text-gray-200 px-3 py-1.5 rounded text-sm">Cancel</button>
            <button type="submit" disabled={!valid || sending} className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-3 py-1.5 rounded text-sm font-medium">
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
