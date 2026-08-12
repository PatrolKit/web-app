import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';

export default function OrgSellerLookupPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [last4, setLast4] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await api.public.findSeller(orgSlug!, email.trim(), last4.trim());
      navigate(`/s/${data.sellerId}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setError('Too many attempts. Please try again in a moment.');
        } else {
          setError("We couldn't find a seller matching that email and phone.");
        }
      } else {
        setError('Network error. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-start pt-20 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <span className="text-2xl font-bold">
            <span className="text-brand-600">Patrol</span>Kit
          </span>
          <h1 className="text-xl font-semibold text-white mt-2">Ski Swap — Item Status</h1>
          <p className="text-gray-400 text-sm mt-1">
            Enter your email and the last 4 digits of your phone to check your items.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            required
            autoComplete="email"
            className="w-full bg-surface-50 border border-gray-700 rounded px-3 py-3 text-white text-sm placeholder-gray-500"
          />
          <input
            type="text"
            value={last4}
            onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="Last 4 digits of phone"
            required
            inputMode="numeric"
            maxLength={4}
            pattern="\d{4}"
            className="w-full bg-surface-50 border border-gray-700 rounded px-3 py-3 text-white text-sm placeholder-gray-500"
          />
          <button
            type="submit"
            disabled={loading || last4.length !== 4}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white py-3 rounded font-medium text-sm"
          >
            {loading ? 'Looking up…' : 'Find My Items'}
          </button>
        </form>

        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
      </div>
    </div>
  );
}
