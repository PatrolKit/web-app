import ExportMenu from '../../components/ExportMenu';
import { api } from '../../lib/api';
import type { ItemListView } from '../../lib/api.types';

/** The Items page's filters, as the export takes them. */
export type ExportFilters = { query?: string; sellerId?: string } & ItemListView;

/**
 * The Items page's Export menu: every item matching the filters on screen (not
 * one page), as a spreadsheet to download or email. The server reads sales
 * fresh from Square for it, which can take a little while.
 */
export default function ItemsExport({ orgId, swapId, filters, defaultEmail }: {
  orgId: string; swapId: string; filters: ExportFilters; defaultEmail: string;
}) {
  return (
    <ExportMenu
      defaultEmail={defaultEmail}
      busyText="Reading sales from Square…"
      emailBlurb="Every item matching the filters on screen, with sales read from Square now. It includes sellers’ phone numbers and email addresses."
      download={() => api.skiSwap.exportItems(orgId, swapId, filters)}
      email={async (to) => {
        const r = await api.skiSwap.emailItemsExport(orgId, swapId, {
          to,
          ...(filters.query ? { query: filters.query } : {}),
          ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
          ...(filters.status ? { status: filters.status } : {}),
          ...(filters.sellerKind ? { sellerKind: filters.sellerKind } : {}),
          ...(filters.printed !== undefined ? { printed: filters.printed ? 'true' as const : 'false' as const } : {}),
          ...(filters.sort ? { sort: filters.sort, dir: filters.dir ?? 'asc' } : {}),
        });
        return `Emailed ${r.items.toLocaleString('en-US')} item${r.items === 1 ? '' : 's'} to ${r.to}.`;
      }}
    />
  );
}
