import ExportMenu from '../../../components/ExportMenu';
import { api } from '../../../lib/api';

/**
 * Payouts by seller as a spreadsheet, to download or email: the swap's (every
 * seller with sales, on the Payouts page) or one run's (on its page). A seller
 * already paid shows what was paid; everyone else, what they're owed now.
 */
export default function PayoutsExport({ orgId, scope, defaultEmail }: {
  orgId: string; scope: { swapId: string } | { runId: string }; defaultEmail: string;
}) {
  return (
    <ExportMenu
      defaultEmail={defaultEmail}
      busyText="Reading sales from Square…"
      emailBlurb={`${'runId' in scope ? 'This run’s sellers' : 'Every seller with sales'}: their payouts, the tickets they’re for, and where each payment stands. It includes sellers’ contact details, mailing addresses and where they’re paid.`}
      download={() => api.skiSwap.exportPayouts(orgId, scope)}
      email={async (to) => {
        const r = await api.skiSwap.emailPayoutsExport(orgId, scope, to);
        return `Emailed ${r.sellers.toLocaleString('en-US')} seller${r.sellers === 1 ? '' : 's'} to ${r.to}.`;
      }}
    />
  );
}
