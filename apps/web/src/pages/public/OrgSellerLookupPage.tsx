import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { OrgBrandingResponse } from '../../lib/api.types';
import { PoweredByFooter } from './PoweredByFooter';

export default function OrgSellerLookupPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [last4, setLast4] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branding, setBranding] = useState<OrgBrandingResponse | null>(null);
  const [orgNotFound, setOrgNotFound] = useState(false);

  useEffect(() => {
    if (!orgSlug) return;
    api.public.getOrgBranding(orgSlug)
      .then(setBranding)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setOrgNotFound(true);
      });
  }, [orgSlug]);

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

  if (orgNotFound) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 text-center">
        <img src="/logo.png" alt="PatrolKit" className="w-12 h-12 mx-auto mb-4 rounded-lg" />
        <h1 className="text-white font-semibold text-lg">Page not found</h1>
        <p className="text-gray-400 text-sm mt-1">This link doesn't match any active ski swap. Check the URL and try again.</p>
        <PoweredByFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex flex-col items-center justify-start pt-20 px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <img
            src={branding?.logoUrl ?? '/logo.png'}
            alt={branding?.orgName ?? 'PatrolKit'}
            className="w-16 h-16 mx-auto mb-3 rounded-lg object-contain"
          />
          {branding?.orgName && (
            <p className="text-brand-500 font-semibold text-sm mb-1">{branding.orgName}</p>
          )}
          <h1 className="text-xl font-semibold text-white">Ski Swap Item Status</h1>
          <p className="text-gray-400 text-sm mt-1">
            Enter your email and the last 4 digits of your phone to check your items.
          </p>
        </div>

        {/* No swap shows seller status publicly (Plan 33): say so, rather
            than offer a form that can't find anybody. */}
        {branding && !branding.sellerLookupOpen ? (
          <p className="text-gray-400 text-sm text-center">Item status isn’t available here right now.</p>
        ) : (
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
        )}

        {error && <p className="text-red-400 text-sm text-center">{error}</p>}
        <PoweredByFooter />
      </div>
    </div>
  );
}
