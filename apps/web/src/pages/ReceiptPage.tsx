import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PublicPageHeader } from './public/PublicPageHeader';
import { PoweredByFooter } from './public/PoweredByFooter';
import { FinePrintCallout, RECEIPT_LINK_LABELS } from './public/receiptLayout';
import type { PublicReceiptResponse } from '../lib/api.types';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "Oct 4, 2026, 2:30 PM EDT", in the swap's zone, or the viewer's if the browser doesn't know it. */
function checkinTime(iso: string, timeZone: string | undefined): string {
  const options: Intl.DateTimeFormatOptions = {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  };
  try {
    return new Date(iso).toLocaleString('en-US', { ...options, timeZone });
  } catch {
    return new Date(iso).toLocaleString('en-US', options);
  }
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
 *
 * What it shows follows the swap's receipt settings (Plan 36): the columns, a
 * status-page-only receipt with no table, the link by where it goes, and the
 * fine print. A swap that gives no receipts answers 404, as a wrong link does.
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

  const { layout } = data;
  const { show, link } = layout;
  const itemized = layout.mode === 'ITEMIZED';
  const itemCount = `${data.itemCount} item${data.itemCount === 1 ? '' : 's'}`;

  // In the swap's zone, and saying which: the same time the email and the
  // printed receipt give, wherever the seller opens this.
  const when = checkinTime(data.createdAt, data.timeZone);

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

      {itemized ? (
        <>
          <ul className="mt-4 border-t border-gray-800">
            {data.lines.map((line) => (
              <li
                key={line.sku}
                className="flex items-start justify-between gap-3 py-2.5 border-b border-gray-800"
              >
                <span className="min-w-0">
                  {show.name && <span className="block text-sm text-white">{line.name}</span>}
                  {show.sku && (
                    <span className={show.name ? 'block text-xs text-gray-500' : 'block text-sm text-white font-mono'}>
                      {line.sku}
                    </span>
                  )}
                </span>
                {show.price && (
                  <span className={`text-sm whitespace-nowrap ${line.priceCents === null ? 'text-gray-400' : 'font-medium text-white'}`}>
                    {linePrice(line.priceCents)}
                  </span>
                )}
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
              {itemCount}
              {show.price && data.unpricedCount > 0 && ` · ${data.unpricedCount} with price to come`}
            </span>
            {/* Price off takes the total with it. */}
            {show.price && (
              <span className="text-right">
                {data.unpricedCount > 0 && <span className="block text-xs text-gray-500">Total of priced items</span>}
                <span className="text-lg font-bold text-white">{money(data.totalCents)}</span>
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="mt-4 text-center">
          <p className="text-white">Your {itemCount} {data.itemCount === 1 ? 'is' : 'are'} checked in.</p>
          {/* The page linked to has been turned off since: say so rather
              than leave the receipt blank. */}
          {!link && <p className="mt-1 text-sm text-gray-500">The swap’s status page isn’t available right now.</p>}
        </div>
      )}

      {data.payoutLabel && (
        <p className="text-xs text-gray-500 mt-4">
          Payment goes to <span className="text-gray-300">{data.payoutLabel}</span>
        </p>
      )}

      {/* The receipt is frozen, so the question it cannot answer — what has
          happened since — gets a way out to the page that can, when the swap
          links to one that's on. */}
      {link && (
        <>
          <a
            href={link.url}
            className="block text-center bg-brand-600 hover:bg-brand-700 text-white text-sm font-medium rounded-lg py-3 mt-6"
          >
            {RECEIPT_LINK_LABELS[link.kind].button}
          </a>
          <p className="mt-2 text-center text-xs text-gray-500">{RECEIPT_LINK_LABELS[link.kind].caption}</p>
        </>
      )}

      {layout.finePrint && (
        <div className="mt-6">
          <FinePrintCallout html={layout.finePrint} />
        </div>
      )}

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
