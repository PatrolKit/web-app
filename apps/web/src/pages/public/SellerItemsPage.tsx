import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { PoweredByFooter } from './PoweredByFooter';

function formatPrice(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
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
        {/* Header */}
        <div className="flex flex-col items-center gap-2">
          {data.orgLogoUrl ? (
            <img src={data.orgLogoUrl} alt={data.orgName} className="h-12 object-contain" />
          ) : (
            <span className="text-xl font-bold text-white">{data.orgName}</span>
          )}
          <h1 className="text-lg font-semibold text-white">Ski Swap — Item Status</h1>
          <p className="text-gray-400 text-sm">{data.sellerName}</p>
        </div>

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
                        const sold = item.soldCount > 0;
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
                                    : 'bg-surface-100 text-gray-400'
                                }`}
                              >
                                {sold ? 'Sold' : 'Not yet sold'}
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
        <PoweredByFooter />
      </div>
    </div>
  );
}
