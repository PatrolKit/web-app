import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { PublicReceiptResponse } from '../lib/api.types';

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
    return <Frame><p className="text-sm text-gray-500">Loading…</p></Frame>;
  }

  // A revoked link and a wrong one look the same on purpose: neither should
  // confirm that a receipt was ever there.
  if (error || !data) {
    return (
      <Frame>
        <h1 className="text-xl font-semibold text-white">Receipt not available</h1>
        <p className="text-sm text-gray-400 mt-2">
          This link may have expired or been replaced. Ask the club for a new one.
        </p>
      </Frame>
    );
  }

  const when = new Date(data.createdAt).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  return (
    <Frame>
      <div className="flex items-start gap-3">
        {data.orgLogoUrl && (
          <img src={data.orgLogoUrl} alt="" className="h-10 w-10 object-contain rounded" />
        )}
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-white truncate">{data.orgName}</h1>
          <p className="text-sm text-gray-400 truncate">{data.swapTitle}</p>
        </div>
      </div>

      <p className="text-xs text-gray-500 mt-3">
        Checked in {when} · {data.sellerName}
      </p>

      <ul className="mt-5 border-t border-gray-800">
        {data.lines.map((line) => (
          <li
            key={line.sku}
            className="flex items-start justify-between gap-3 py-2.5 border-b border-gray-800"
          >
            <span className="min-w-0">
              <span className="block text-sm text-white">{line.name}</span>
              <span className="block text-xs text-gray-500">{line.sku}</span>
            </span>
            <span className="text-sm font-medium text-white whitespace-nowrap">
              {money(line.priceCents)}
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
        </span>
        <span className="text-lg font-bold text-white">{money(data.totalCents)}</span>
      </div>

      {data.payoutLabel && (
        <p className="text-xs text-gray-500 mt-4">
          Payment goes to <span className="text-gray-300">{data.payoutLabel}</span>
        </p>
      )}

      <p className="text-xs text-gray-500 mt-6 pt-4 border-t border-gray-800">
        This is a record of what you dropped off. It does not change as items sell.
      </p>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface px-4 py-10">
      <div className="max-w-md mx-auto bg-surface-50 border border-gray-800 rounded-xl p-5">
        {children}
      </div>
      <p className="max-w-md mx-auto text-center text-xs text-gray-600 mt-6">
        Powered by <span className="text-brand-500">PatrolKit</span>
      </p>
    </div>
  );
}
