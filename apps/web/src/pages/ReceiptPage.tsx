import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PublicPageHeader } from './public/PublicPageHeader';
import { PoweredByFooter } from './public/PoweredByFooter';
import type { PublicReceiptResponse } from '../lib/api.types';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** A line's price, or that it has none yet: a ticket priced after check-in (Plan 32). */
function linePrice(cents: number | null): string {
  return cents === null ? 'Price to come' : money(cents);
}

/**
 * A receipt, as emailed or texted (Plan 24 §7).
 *
 * Public, and the token in the URL is the whole credential — so this renders
 * one check-in and nothing else. The seller's live page is a link away rather
 * than inlined here: that one answers "has my stuff sold?", and widening a
 * receipt link to mean the same thing is what the separate token exists to
 * avoid.
 */
export default function ReceiptPage() {
  const { token = '' } = useParams();

  const { data, isLoading, error } = useQuery<PublicReceiptResponse>({
    queryKey: ['public/receipt', token],
    queryFn: () => api.public.getReceipt(token),
    enabled: !!token,
    retry: false,
  });

  if (isLoading) {
    return <Frame header={<p className="text-center text-sm text-gray-500">Loading…</p>} />;
  }

  // A revoked link and a wrong one look the same on purpose: neither should
  // confirm that a receipt was ever there.
  if (error || !data) {
    return (
      <Frame
        header={
          <PublicPageHeader
            title="Receipt not available"
            subtitle="This link may have expired or been replaced. Ask the club for a new one."
          />
        }
      />
    );
  }

  const when = new Date(data.createdAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  return (
    <Frame
      /* The same header as check-in and item tracking. A seller reaches this
         from a link in one of them, so it should not look like somewhere
         else. */
      header={
        <PublicPageHeader
          title="Your receipt"
          subtitle={[data.orgName, data.swapTitle]}
          logoUrl={data.orgLogoUrl}
        />
      }
    >
      <div className="bg-surface-50 border border-gray-800 rounded-xl p-5">
      <p className="text-xs text-gray-500 text-center">
        Checked in {when} · {data.sellerName}
      </p>

      <ul className="mt-4 border-t border-gray-800">
        {data.lines.map((line) => (
          <li
            key={line.sku}
            className="flex items-start justify-between gap-3 py-2.5 border-b border-gray-800"
          >
            <span className="min-w-0">
              <span className="block text-sm text-white">{line.name}</span>
              <span className="block text-xs text-gray-500">{line.sku}</span>
            </span>
            <span className={`text-sm whitespace-nowrap ${line.priceCents === null ? 'text-gray-400' : 'font-medium text-white'}`}>
              {linePrice(line.priceCents)}
            </span>
          </li>
        ))}
        {data.lines.length === 0 && (
          <li className="py-3 text-sm text-gray-500 border-b border-gray-800">
            No items were checked in.
          </li>
        )}
      </ul>

      <div className="flex items-baseline justify-between pt-3">
        <span className="text-sm text-gray-400">
          {data.itemCount} item{data.itemCount === 1 ? '' : 's'}
          {data.unpricedCount > 0 && ` · ${data.unpricedCount} with price to come`}
        </span>
        <span className="text-right">
          {data.unpricedCount > 0 && <span className="block text-xs text-gray-500">Total of priced items</span>}
          <span className="text-lg font-bold text-white">{money(data.totalCents)}</span>
        </span>
      </div>

      {data.payoutLabel && (
        <p className="text-xs text-gray-500 mt-4">
          Payment goes to <span className="text-gray-300">{data.payoutLabel}</span>
        </p>
      )}

      {/* The receipt is frozen, so the question it cannot answer — what has
          happened since — gets a way out to the page that can. */}
      <a
        href={data.trackUrl}
        className="block text-center bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg py-3 mt-6"
      >
        Track your items
      </a>

      <p className="text-xs text-gray-500 mt-4 pt-4 border-t border-gray-800">
        This is a record of what you dropped off. It does not change as items sell.
      </p>
      </div>
    </Frame>
  );
}

/**
 * `CheckinShell`'s chrome without its sign-in line, which a public page has no
 * business showing. The header sits above the card rather than inside it, the
 * way it does on check-in and on item tracking.
 */
function Frame({ header, children }: { header: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="mx-auto w-full max-w-md px-4 py-6 space-y-6">
        {header}
        {children}
        <PoweredByFooter />
      </div>
    </div>
  );
}
