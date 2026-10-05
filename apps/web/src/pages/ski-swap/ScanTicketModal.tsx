import { useEffect, useRef, useState } from 'react';
import { faCircleXmark as faCircleXmarkDuo } from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { useScanner } from '../../contexts/ScannerContext';
import { itemState } from './SwapItemsPanel';
import { Banner, ScannerBanner, TypedCode, errorTone } from './ScanSessionParts';
import { looked, settled, type Lookup } from './scanTicketLogic';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Scan Ticket: look items up by their tag, as fast as they're scanned. Any
 * item's tag, ticket or PatrolKit label; each shows its SKU, seller, price,
 * description and whether it has sold (live from Square). Nothing here edits.
 *
 * The same scanner banners and tone as Batch add; the last scan large, and
 * this session's scans listed underneath, newest first.
 */
export default function ScanTicketModal({ orgId, swapId, onClose }: {
  orgId: string;
  swapId: string;
  onClose: () => void;
}) {
  const { subscribe } = useScanner();
  const [lookups, setLookups] = useState<Lookup[]>([]);
  const lookupsRef = useRef(lookups);
  const nextKey = useRef(1);
  /** The row shown large: the newest, unless one in the list was picked. */
  const [pickedKey, setPickedKey] = useState<number | null>(null);

  const commit = (next: Lookup[]) => { lookupsRef.current = next; setLookups(next); };

  function look(raw: string) {
    const key = nextKey.current++;
    const r = looked(lookupsRef.current, raw, key);
    if (!r.code) return;
    commit(r.lookups);
    setPickedKey(null);
    const code = r.code;
    api.skiSwap.findItemBySku(orgId, swapId, code)
      .then((item) => commit(settled(lookupsRef.current, key, { state: 'found', item })))
      .catch((err: unknown) => {
        errorTone();
        commit(settled(lookupsRef.current, key, err instanceof ApiError && err.status === 404
          ? { state: 'missing' }
          : { state: 'failed', error: err instanceof Error ? err.message : 'Could not look it up.' }));
      });
  }
  const lookRef = useRef(look);
  lookRef.current = look;

  // Every scan, for as long as the popover is open.
  useEffect(() => subscribe((scan) => lookRef.current(scan.payload)), [subscribe]);

  const shown = lookups.find((l) => l.key === pickedKey) ?? lookups[0] ?? null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 pt-[6vh] z-50" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Scan ticket"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-2xl p-5 space-y-4 max-h-[88vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 shrink-0">
          <div>
            <h3 className="text-white font-medium">Scan Ticket</h3>
            <p className="text-gray-400 text-sm mt-0.5">Scan any item’s tag to see what it is and whether it has sold. Nothing here changes it.</p>
          </div>
          <button type="button" onClick={onClose} className="shrink-0 bg-surface-100 hover:bg-surface-200 text-gray-200 px-3 py-1.5 rounded text-sm">
            Done
          </button>
        </div>

        <ScannerBanner ready={{ title: lookups.length ? 'Keep scanning' : 'Start scanning', text: 'Scan a ticket or tag to look it up.' }} />

        {shown?.state === 'missing' && (
          <Banner tone="error" icon={faCircleXmarkDuo} title="Not found" text={`${shown.code} isn’t an item in this swap.`} />
        )}
        {shown?.state === 'failed' && (
          <Banner tone="error" icon={faCircleXmarkDuo} title="Couldn’t look it up" text={`${shown.code}: ${shown.error}`} />
        )}

        {/* The item, large. */}
        {shown?.state === 'looking' && (
          <div className="shrink-0 bg-surface-100 rounded-lg px-4 py-4">
            <p className="text-3xl font-mono font-bold text-white">{shown.code}</p>
            <p className="text-sm text-gray-500 mt-1">Looking it up…</p>
          </div>
        )}
        {shown?.state === 'found' && shown.item && <ItemCard item={shown.item} />}
        {!shown && (
          <div className="shrink-0 bg-surface-100 rounded-lg px-4 py-6 text-center text-sm text-gray-500">
            The item you scan shows here.
          </div>
        )}

        <TypedCode placeholder="Barcode won’t read? Type the SKU" onEnter={look} button="Look up" />

        <ul className="flex-1 min-h-0 overflow-y-auto border border-gray-800 rounded divide-y divide-gray-800" aria-label="Scanned this session">
          {lookups.length === 0 && <li className="px-3 py-3 text-sm text-gray-500">This session’s scans appear here, newest first.</li>}
          {lookups.map((l) => (
            <li key={l.key}>
              <button type="button" onClick={() => setPickedKey(l.key)}
                className={`w-full flex items-center justify-between gap-3 px-3 py-1.5 text-sm text-left hover:bg-surface-100 ${shown?.key === l.key ? 'bg-surface-100' : ''}`}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-gray-200 shrink-0">{l.code}</span>
                  <span className="truncate text-gray-400">
                    {l.state === 'looking' ? 'Looking…'
                      : l.state === 'missing' ? <span className="text-red-400">Not found</span>
                        : l.state === 'failed' ? <span className="text-red-400">Couldn’t look it up</span>
                          : [l.item!.name, l.item!.seller?.displayName].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {l.state === 'found' && l.item && (
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-gray-300">{l.item.priceCents === null ? 'No price' : money(l.item.priceCents)}</span>
                    <StateBadge item={l.item} />
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function StateBadge({ item }: { item: NonNullable<Lookup['item']> }) {
  const st = itemState(item);
  return <span title={st.title} className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${st.tone}`}>{st.label}</span>;
}

/** What the scanned item is: SKU and status, description, seller, price, notes. */
function ItemCard({ item }: { item: NonNullable<Lookup['item']> }) {
  return (
    <div className="shrink-0 bg-surface-100 rounded-lg px-4 py-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-3xl font-mono font-bold text-white">{item.sku}</p>
        <StateBadge item={item} />
      </div>
      <p className="text-xl text-white">{item.name}</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-xs uppercase text-gray-500">Seller</p>
          <p className="text-base text-gray-200">{item.seller?.displayName ?? '—'}</p>
        </div>
        <div>
          <p className="text-xs uppercase text-gray-500">Price</p>
          <p className={`text-base ${item.priceCents === null ? 'text-amber-400' : 'text-gray-200'}`}>
            {item.priceCents === null ? 'No price yet' : money(item.priceCents)}
          </p>
        </div>
      </div>
      {item.description && (
        <div>
          <p className="text-xs uppercase text-gray-500">Notes</p>
          <p className="text-sm text-gray-300">{item.description}</p>
        </div>
      )}
      {item.donateProceeds && <p className="text-xs text-gray-400">❤️ Proceeds donated to ski patrol</p>}
    </div>
  );
}
