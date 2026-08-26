import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { SELLER_SITE_URL } from '../../lib/sellerSiteUrl';
import { CheckinShell, formatCents } from './shared';
import type { CheckinContext, CheckinSummary } from '../../lib/api.types';

/**
 * The last screen: what to do with the items, and where to check on them later.
 *
 * The receipt is already queued at the station's printer by the time this
 * renders, so this is confirmation rather than an action.
 */
export default function FinishStep({ context }: { context: CheckinContext }) {
  const { data: summary } = useQuery<CheckinSummary>({
    queryKey: ['checkin/summary', context.orgId, context.swapId],
    queryFn: () => api.checkin.summary(context.orgId, context.swapId),
  });

  return (
    <CheckinShell
      title="You're checked in"
      subtitle={`${context.swapTitle} · ${context.stationName}`}
      logoUrl={context.orgLogoUrl}
    >
      <div className="bg-surface-50 border border-gray-800 rounded-xl p-4 space-y-3">
        <p className="text-sm text-gray-300">
          Your receipt is printing at this station. Take it with you — it lists everything
          you dropped off.
        </p>
        <ol className="text-sm text-gray-400 space-y-2 list-decimal list-inside">
          <li>Put a tag on each item.</li>
          <li>Hand your items to a volunteer at this station.</li>
          <li>Keep the receipt to track sales and collect payment.</li>
        </ol>
      </div>

      {summary && (
        <div className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-sm font-medium text-gray-300">
              {summary.items.length} item{summary.items.length === 1 ? '' : 's'}
            </h2>
            <span className="text-sm text-gray-400">{formatCents(summary.totalCents)}</span>
          </div>
          <ul className="space-y-1.5">
            {summary.items.map((item) => (
              <li key={item.id} className="bg-surface-50 border border-gray-800 rounded-lg px-3 py-2">
                <p className="text-sm text-white truncate">{item.name}</p>
                <p className="text-xs text-gray-500">{item.sku} · {formatCents(item.priceCents)}</p>
              </li>
            ))}
          </ul>

          <a
            href={`${SELLER_SITE_URL}/s/${summary.sellerId}`}
            className="block text-center text-sm text-brand-600 hover:underline py-3"
          >
            Track your items
          </a>
        </div>
      )}
    </CheckinShell>
  );
}
