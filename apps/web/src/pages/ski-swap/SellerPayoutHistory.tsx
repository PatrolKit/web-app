import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { PayoutChangeView } from '../../lib/api.types';
import { methodLabel, whenText } from './payouts/payoutView';

/** The day PatrolKit started keeping payout changes; nothing before it was recorded. */
const RECORDED_FROM = 'Nov 13, 2026';

type PayoutState = PayoutChangeView['to'];

const stateText = (s: PayoutState) => (s.destination ? `${methodLabel(s.method)} (${s.destination})` : methodLabel(s.method));

/** "PayPal (dana@example.com) → Check (12 Main St, …)", or "Set to PayPal (…)" the first time. */
export function changeText(c: PayoutChangeView): string {
  return c.from ? `${stateText(c.from)} → ${stateText(c.to)}` : `Set to ${stateText(c.to)}`;
}

/** Who made it: "by Alex Smith", "on Counter iPad 3", "by the seller", "by Alex Smith, merging sellers". */
export function byText(c: PayoutChangeView): string {
  switch (c.via) {
    case 'tablet': return c.by ? `on ${c.by}` : 'on an iPad';
    case 'seller': return 'by the seller';
    case 'merge': return `by ${c.by ?? 'staff'}, merging sellers`;
    default: return `by ${c.by ?? 'staff'}`;
  }
}

/** A seller's payout changes, newest first, under the Payout fields of their edit form. */
export default function SellerPayoutHistory({ orgId, sellerId }: { orgId: string; sellerId: string }) {
  // Under the sellers key, so saving a seller reads it again.
  const { data, isLoading, error } = useQuery({
    queryKey: ['ski-swap/sellers', orgId, sellerId, 'payout-history'],
    queryFn: () => api.skiSwap.sellerPayoutHistory(orgId, sellerId),
  });

  return (
    <div className="space-y-1">
      <p className="text-gray-400 text-xs">Payout history</p>
      {isLoading ? (
        <p className="text-xs text-gray-500">Loading…</p>
      ) : error ? (
        <p className="text-xs text-red-300">Couldn’t load the payout history.</p>
      ) : !data?.length ? (
        <p className="text-xs text-gray-500">No changes recorded. Changes are recorded from {RECORDED_FROM}.</p>
      ) : (
        <ul className="space-y-1">
          {data.map((c) => (
            <li key={c.at} className="text-xs">
              <span className="text-gray-200 break-words">{changeText(c)}</span>
              <span className="block text-gray-500">{whenText(c.at)} · {byText(c)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
