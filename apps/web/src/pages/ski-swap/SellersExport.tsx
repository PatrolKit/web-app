import ExportMenu from '../../components/ExportMenu';
import { api } from '../../lib/api';
import type { SellerFilters } from '@patrolkit/contracts/seller-filter';

/**
 * The Sellers page's Export menu: every seller matching the filters on screen,
 * as a spreadsheet to download or email, in the page's order: contact, how
 * and where they're paid, whether they can be, and mailing address.
 */
export default function SellersExport({ orgId, filters, defaultEmail }: {
  orgId: string; filters: SellerFilters; defaultEmail: string;
}) {
  return (
    <ExportMenu
      defaultEmail={defaultEmail}
      busyText="Making the spreadsheet…"
      emailBlurb="Every seller matching the filters on screen. It includes their phone numbers, email and mailing addresses, and how they’re paid."
      download={() => api.skiSwap.exportSellers(orgId, filters)}
      email={async (to) => {
        const r = await api.skiSwap.emailSellersExport(orgId, filters, to);
        return `Emailed ${r.sellers.toLocaleString('en-US')} seller${r.sellers === 1 ? '' : 's'} to ${r.to}.`;
      }}
    />
  );
}
