import { useState } from 'react';
import { useParams } from 'react-router-dom';
import type { PublicSellerLookupResponse } from '../../lib/api.types';

export default function SellerStatusPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const [phone, setPhone] = useState('');
  const [swapId, setSwapId] = useState('');
  const [result, setResult] = useState<PublicSellerLookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ phone: phone.trim() });
      if (swapId) params.set('swapId', swapId);
      const res = await fetch(`/api/v1/public/${orgSlug}/ski-swap/seller-lookup?${params}`);
      if (!res.ok) {
        if (res.status === 404) { setError('This organization does not have an active ski swap.'); return; }
        setError('Unable to check status. Please try again.');
        return;
      }
      const body = await res.json() as { success: boolean; data: PublicSellerLookupResponse };
      setResult(body.data);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-start pt-20 px-4">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center">
          <span className="text-2xl font-bold"><span className="text-brand-600">Patrol</span>Kit</span>
          <h1 className="text-xl font-semibold text-white mt-2">Ski Swap — Item Status</h1>
          <p className="text-gray-400 text-sm mt-1">Enter your phone number to check the status of your items.</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Phone number"
            required
            className="w-full bg-surface-50 border border-gray-700 rounded px-3 py-3 text-white text-sm placeholder-gray-500"
          />
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-700 text-white py-3 rounded font-medium text-sm"
          >
            {loading ? 'Checking…' : 'Check My Items'}
          </button>
        </form>

        {/* Error */}
        {error && <p className="text-red-400 text-sm text-center">{error}</p>}

        {/* Results */}
        {result && (
          <div className="space-y-3">
            {result.items.length === 0 ? (
              <p className="text-gray-400 text-sm text-center">
                No items found for this phone number in active swaps.
              </p>
            ) : (
              <>
                {result.sellerName && (
                  <p className="text-gray-300 text-sm">Items for <span className="text-white font-medium">{result.sellerName}</span>:</p>
                )}
                <div className="space-y-2">
                  {result.items.map((item) => (
                    <div key={item.squareItemId} className="bg-surface-50 border border-gray-700 rounded-lg p-3 flex justify-between items-center">
                      <div>
                        <p className="text-white text-sm font-medium">{item.name}</p>
                        <p className="text-gray-400 text-xs">${(item.priceCents / 100).toFixed(2)}</p>
                      </div>
                      <div className="text-right">
                        {item.soldCount > 0 ? (
                          <span className="text-green-400 text-sm font-medium">Sold!</span>
                        ) : item.inStock > 0 ? (
                          <span className="text-gray-300 text-sm">Available ({item.inStock})</span>
                        ) : (
                          <span className="text-gray-500 text-sm">Not in stock</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
