import { useParams } from 'react-router-dom';
import { itemPrice } from '../../lib/money';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { PoweredByFooter } from './PoweredByFooter';
import { PublicPageHeader } from './PublicPageHeader';
import type { PayoutMethod, PublicSellerPayout } from '../../lib/api.types';

function formatPrice(cents: number | null) {
  return itemPrice(cents);
}

/**
 * Roughly when the money turns up.
 *
 * The question every seller asks a volunteer a fortnight after a swap, and the
 * one thing the tracking page could answer without anybody being asked. Shown
 * from their chosen method alone, so it is there from check-in rather than
 * only once a payout run exists — which is weeks later, and long after they
 * started wondering.
 *
 * Counted from the end of the swap rather than from today, because that is
 * when the work starts: nothing can be totalled until the last sale is in.
 *
 * Deliberately vague. These are estimates given to somebody who will remember
 * the number, so they say "about" and lean long.
 */
function payoutTiming(method: PayoutMethod): string | null {
  switch (method) {
    case 'CHECK':
      return 'Checks are written and posted about four weeks after the swap ends.';
    case 'PAYPAL':
      return 'PayPal payouts usually go out about a week after the swap ends.';
    case 'VENMO':
      return 'Venmo payouts usually go out about a week after the swap ends.';
    case 'DONATE':
      // Nothing is coming, and saying when would be strange.
      return null;
  }
}

/** True once nothing is outstanding, so the estimate stops being useful. */
function allSettled(payouts: PublicSellerPayout[]): boolean {
  return payouts.length > 0 && payouts.every(
    (p) => p.status === 'SENT' || p.status === 'PAID_BY_CHECK' || p.status === 'DONATED',
  );
}

/**
 * What the seller is owed, and where it went (Plan 25 §8).
 *
 * The arithmetic is shown rather than only the total. A seller who sold $315
 * and receives $252 should be able to see the $63 and what it was for, on the
 * same screen, without having to ask anybody.
 */
function PayoutsSection({ payouts }: { payouts: PublicSellerPayout[] }) {
  return (
    <div className="space-y-2">
      <h2 className="text-white font-medium text-sm">Your payout</h2>
      <div className="space-y-3">
        {payouts.map((payout, i) => (
          <PayoutCard key={`${payout.swapTitle}-${i}`} payout={payout} />
        ))}
      </div>
    </div>
  );
}

function PayoutTiming({ method }: { method: PayoutMethod }) {
  const line = payoutTiming(method);
  if (!line) return null;

  return (
    <div className="rounded-lg border border-gray-800 bg-surface-50 px-4 py-3">
      <p className="text-xs text-gray-400">{line}</p>
      <p className="text-xs text-gray-500 mt-1">
        This page is the place to check — it updates on its own, so there is no need to call
        and ask.
      </p>
    </div>
  );
}

function PayoutCard({ payout }: { payout: PublicSellerPayout }) {
  const { line, tone } = describe(payout);

  return (
    <div className="rounded-lg border border-gray-700 p-4 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-gray-400 text-xs">{payout.swapTitle}</span>
        <span className={`text-xs px-2 py-0.5 rounded ${tone}`}>{label(payout)}</span>
      </div>

      <dl className="space-y-1 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-400">Sold</dt>
          <dd className="text-white">{formatPrice(payout.grossCents)}</dd>
        </div>
        {payout.commissionCents > 0 && (
          <div className="flex justify-between">
            <dt className="text-gray-400">Patrol ({payout.commissionPercent})</dt>
            <dd className="text-gray-300">−{formatPrice(payout.commissionCents)}</dd>
          </div>
        )}
        <div className="flex justify-between border-t border-gray-800 pt-1 mt-1">
          <dt className="text-white font-medium">Payout</dt>
          <dd className="text-white font-semibold">{formatPrice(payout.netCents)}</dd>
        </div>
      </dl>

      <p className={`text-xs ${payout.needsAction ? 'text-amber-300' : 'text-gray-400'}`}>{line}</p>
    </div>
  );
}

function label(payout: PublicSellerPayout): string {
  switch (payout.status) {
    case 'SENT': return 'Paid';
    case 'PAID_BY_CHECK': return 'Check sent';
    case 'UNCLAIMED': return 'Needs your attention';
    case 'SENDING': return 'On its way';
    case 'FAILED':
    case 'RETURNED': return 'Did not arrive';
    case 'DONATED': return 'Donated';
    default: return 'Being prepared';
  }
}

/**
 * One sentence about where the money is.
 *
 * `UNCLAIMED` is the only state that asks the seller for anything, so it is the
 * only one that says what to do — everywhere else the patrol is the one with
 * something to do, and telling the seller to act would be telling them to chase
 * a thing they cannot move.
 */
function describe(payout: PublicSellerPayout): { line: string; tone: string } {
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }) : '';

  switch (payout.status) {
    case 'SENT':
      return {
        line: `Sent to ${payout.destination ?? 'your account'} on ${when(payout.sentAt)}.`,
        tone: 'bg-green-900/40 text-green-400',
      };
    case 'PAID_BY_CHECK':
      return {
        line: payout.checkSentAt
          ? `A check was posted on ${when(payout.checkSentAt)}.`
          : 'A check is being written for you.',
        tone: 'bg-green-900/40 text-green-400',
      };
    case 'UNCLAIMED':
      return {
        line:
          `We sent this to ${payout.destination ?? 'your account'}, but PayPal could not deliver it — ` +
          `usually because that is not the address on your PayPal account. Get in touch with the ` +
          `patrol and they can send it somewhere else. PayPal returns an unclaimed payment after 30 days.`,
        tone: 'bg-amber-900/40 text-amber-300',
      };
    case 'SENDING':
      return { line: 'On its way through PayPal.', tone: 'bg-blue-900/40 text-blue-300' };
    case 'FAILED':
    case 'RETURNED':
      return {
        line: 'This payment did not go through. The patrol has been told and will sort it out.',
        tone: 'bg-red-900/40 text-red-400',
      };
    case 'DONATED':
      return { line: 'You gave this to the patrol. Thank you.', tone: 'bg-surface-100 text-gray-400' };
    default:
      return {
        line: payout.method === 'CHECK'
          ? 'A check is being prepared for you.'
          : 'Being prepared. Nothing for you to do.',
        tone: 'bg-surface-100 text-gray-400',
      };
  }
}

export default function SellerItemsPage() {
  const { sellerId } = useParams<{ sellerId: string }>();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['public/seller', sellerId],
    queryFn: () => api.public.getSellerDetail(sellerId!),
    enabled: !!sellerId,
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-gray-400 text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4">
        <p className="text-white font-semibold text-lg">Seller not found</p>
        <p className="text-gray-400 text-sm mt-1">
          This link may be invalid or the event is no longer active.
        </p>
      </div>
    );
  }

  const hasItems = data.swaps.some((s) => s.items.length > 0);

  return (
    <div className="min-h-screen bg-surface px-4 py-8">
      <div className="max-w-xl mx-auto space-y-6">
        {/*
          * The same header as check-in and the receipt, because a seller
          * arrives here from one of them.
          *
          * The mark and the org's name used to be alternatives — a club with a
          * logo never saw its own name — and "Ski Swap — Item Status" was
          * quieter than the name above it. This says what the screen is for,
          * loudest, and puts who and where underneath.
          */}
        <PublicPageHeader
          title="Your items"
          subtitle={[data.orgName, data.sellerName]}
          logoUrl={data.orgLogoUrl}
        />

        {/* Content */}
        {!hasItems ? (
          <p className="text-gray-400 text-sm text-center">
            No items found for active swaps.
          </p>
        ) : (
          data.swaps.map((swap) =>
            swap.items.length === 0 ? null : (
              <div key={swap.swapId} className="space-y-2">
                <h2 className="text-white font-medium text-sm">{swap.swapTitle}</h2>
                <div className="overflow-x-auto rounded-lg border border-gray-700">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-700 text-gray-400 text-left">
                        <th className="px-3 py-2 font-medium">Item</th>
                        <th className="px-3 py-2 font-medium">SKU</th>
                        <th className="px-3 py-2 font-medium">Price</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {swap.items.map((item) => {
                        // Waiting outranks everything: the item cannot sell,
                        // because nobody has taken it yet. Then whether Square
                        // could be asked, and only then its answer — a guess
                        // either way would be read as a fact.
                        const waiting = !item.consigned;
                        const unknown = !waiting && item.inventoryKnown === false;
                        const sold = !waiting && !unknown && item.soldCount > 0;
                        return (
                          <tr key={item.itemId} className="border-b border-gray-800 last:border-0">
                            <td className="px-3 py-2 text-white">{item.name}</td>
                            <td className="px-3 py-2 text-gray-400 font-mono text-xs">{item.sku}</td>
                            <td className="px-3 py-2 text-white">{formatPrice(item.priceCents)}</td>
                            <td className="px-3 py-2">
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                                  sold
                                    ? 'bg-green-900/40 text-green-400'
                                    : waiting
                                      ? 'bg-yellow-900/40 text-yellow-300'
                                      : unknown
                                        ? 'bg-amber-900/40 text-amber-300'
                                        : 'bg-surface-100 text-gray-400'
                                }`}
                              >
                                {sold
                                  ? 'Sold'
                                  : waiting
                                    ? 'Waiting to be accepted'
                                    : unknown
                                      ? 'Could not check — try again shortly'
                                      : 'Not yet sold'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ),
          )
        )}
        {/* Optional chaining on purpose. This page is reached from a printed
            tag, so it outlives the deploy that added the field — a seller with
            a cached bundle, or an older API in front of it, should see their
            items rather than a blank screen. */}
        {!!data.payouts?.length && <PayoutsSection payouts={data.payouts} />}

        {/* Under the payouts where there are any, in their place where there
            are none. Either way it is the last thing on the page, which is
            where somebody who has finished reading their items looks next. */}
        {data.payoutMethod && !allSettled(data.payouts ?? []) && (
          <PayoutTiming method={data.payoutMethod} />
        )}

        <PoweredByFooter />
      </div>
    </div>
  );
}
