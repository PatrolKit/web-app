import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { PublicPageHeader } from './PublicPageHeader';
import { PoweredByFooter } from './PoweredByFooter';
import { statusText } from './skuStatusText';

const NOT_FOUND = 'No item with that SKU in this swap.';

/**
 * Unauthenticated SKU Lookup (Plan 33): `<org>/<swap slug>/status`.
 *
 * Anyone can enter one SKU and see whether it has sold: its name and status,
 * nothing else. The SKU stays in the page's state, never in the address bar or
 * history.
 */
export default function SkuStatusPage() {
  const { orgSlug, swapSlug } = useParams<{ orgSlug: string; swapSlug: string }>();
  const [sku, setSku] = useState('');

  const page = useQuery({
    queryKey: ['public/swap-status', orgSlug, swapSlug],
    queryFn: () => api.public.getSwapStatusPage(orgSlug!, swapSlug!),
    enabled: !!orgSlug && !!swapSlug,
    retry: false,
  });

  const check = useMutation({
    mutationFn: (value: string) => api.public.getSkuStatus(orgSlug!, swapSlug!, value),
  });

  if (page.isLoading) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-gray-400 text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  // Closed and missing look the same, on purpose.
  if (page.isError || !page.data) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center px-4 text-center">
        <h1 className="text-white font-semibold text-lg">Page not found</h1>
        <p className="text-gray-400 text-sm mt-1">This link doesn’t match a swap’s status page.</p>
        <PoweredByFooter />
      </div>
    );
  }

  const error = check.error
    ? check.error instanceof ApiError && check.error.status === 429
      ? 'Too many lookups. Please try again in a minute.'
      : check.error instanceof ApiError && check.error.status === 404
        ? NOT_FOUND
        : 'Network error. Please try again.'
    : null;
  const result = check.data;

  return (
    <div className="min-h-screen bg-surface px-4 py-8">
      <div className="max-w-md mx-auto space-y-6">
        <PublicPageHeader
          title="Check the status of your items"
          subtitle={[page.data.orgName, page.data.swapTitle]}
          logoUrl={page.data.orgLogoUrl}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const value = sku.trim();
            if (value) check.mutate(value);
          }}
          className="space-y-3"
        >
          <input
            value={sku}
            onChange={(e) => { setSku(e.target.value); check.reset(); }}
            placeholder="SKU or ticket number"
            aria-label="SKU or ticket number"
            autoCapitalize="characters"
            autoComplete="off"
            className="w-full bg-surface-50 border border-gray-700 rounded px-3 py-3 text-white text-sm placeholder-gray-500 font-mono"
          />
          <button
            type="submit"
            disabled={check.isPending || !sku.trim()}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white py-3 rounded font-medium text-sm"
          >
            {check.isPending ? 'Checking…' : 'Check Status'}
          </button>
        </form>

        {result && (
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-1" aria-live="polite">
            <p className="text-white font-medium">{result.name}</p>
            <p className="text-gray-500 text-xs font-mono">{result.sku}</p>
            <p className={`text-sm font-medium ${statusText(result).tone}`}>{statusText(result).text}</p>
          </div>
        )}
        {error && <p className="text-red-400 text-sm text-center" aria-live="polite">{error}</p>}

        <PoweredByFooter />
      </div>
    </div>
  );
}
