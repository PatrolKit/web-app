import { useState, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';

export default function OrgAdminPage() {
  const { orgId } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();

  const { data: org, isLoading } = useQuery({
    queryKey: ['org', orgId],
    queryFn: () => api.orgs.get(orgId),
    enabled: !!orgId,
    staleTime: 0,
  });

  const [nameValue, setNameValue] = useState('');
  const [slugValue, setSlugValue] = useState('');
  const [slugPendingConfirm, setSlugPendingConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Sync form fields when org data arrives (only once or on reset)
  const [initialised, setInitialised] = useState(false);
  if (org && !initialised) {
    setNameValue(org.name);
    setSlugValue(org.slug);
    setInitialised(true);
  }

  const patchMutation = useMutation({
    mutationFn: (data: { name?: string; slug?: string }) => api.orgs.patch(orgId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org', orgId] });
      setSuccess('Saved.');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (e: Error) => setError(e.message),
  });

  const logoMutation = useMutation({
    mutationFn: (file: File) => api.orgs.uploadLogo(orgId, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org', orgId] });
      setSuccess('Logo updated.');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (e: Error) => setError(e.message),
  });

  const deleteLogoMutation = useMutation({
    mutationFn: () => api.orgs.deleteLogo(orgId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['org', orgId] });
      setSuccess('Logo removed.');
      setTimeout(() => setSuccess(null), 3000);
    },
    onError: (e: Error) => setError(e.message),
  });

  function handleSaveName(e: React.FormEvent) {
    e.preventDefault();
    if (!nameValue.trim() || nameValue.trim() === org?.name) return;
    setError(null);
    patchMutation.mutate({ name: nameValue.trim() });
  }

  function handleSlugSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = slugValue.trim();
    if (!next || next === org?.slug) return;
    setSlugPendingConfirm(true);
  }

  function confirmSlugChange() {
    setSlugPendingConfirm(false);
    setError(null);
    patchMutation.mutate({ slug: slugValue.trim() });
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    logoMutation.mutate(file);
    e.target.value = '';
  }

  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  if (!org) return null;

  const busy = patchMutation.isPending || logoMutation.isPending || deleteLogoMutation.isPending;

  return (
    <div className="space-y-8 max-w-lg">
      <h1 className="text-2xl font-bold text-white">Org Admin</h1>

      {error && <p className="text-red-400 text-sm">{error}</p>}
      {success && <p className="text-green-400 text-sm">{success}</p>}

      {/* Organization Name */}
      <section className="space-y-3">
        <h2 className="text-white font-semibold">Organization Name</h2>
        <form onSubmit={handleSaveName} className="flex gap-2">
          <input
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            className="flex-1 bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            placeholder="Organization name"
          />
          <button
            type="submit"
            disabled={busy || !nameValue.trim() || nameValue.trim() === org.name}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm"
          >
            Save
          </button>
        </form>
      </section>

      {/* Slug */}
      <section className="space-y-3">
        <h2 className="text-white font-semibold">Organization Slug</h2>
        <p className="text-gray-400 text-sm">
          Used in public seller URLs like <code className="text-gray-300">skiswap.patrolkit.io/{org.slug}</code>.
          Changing it will break existing links.
        </p>
        <form onSubmit={handleSlugSubmit} className="flex gap-2">
          <input
            value={slugValue}
            onChange={(e) => setSlugValue(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            className="flex-1 bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm font-mono"
            placeholder="org-slug"
          />
          <button
            type="submit"
            disabled={busy || !slugValue.trim() || slugValue.trim() === org.slug}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm"
          >
            Save
          </button>
        </form>
      </section>

      {/* Logo */}
      <section className="space-y-3">
        <h2 className="text-white font-semibold">Organization Logo</h2>
        <p className="text-gray-400 text-sm">
          Shown on seller-facing pages instead of the PatrolKit logo. PNG or JPG, max 2 MB.
        </p>
        {org.logoUrl ? (
          <div className="flex items-center gap-4">
            <img src={org.logoUrl} alt="Org logo" className="h-16 object-contain rounded border border-gray-700 p-1 bg-white" />
            <div className="flex gap-2">
              <button
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="bg-surface-50 hover:bg-surface-100 border border-gray-700 text-white px-3 py-1.5 rounded text-sm disabled:opacity-40"
              >
                Change
              </button>
              <button
                onClick={() => deleteLogoMutation.mutate()}
                disabled={busy}
                className="text-red-500 hover:text-red-400 text-sm disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="bg-surface-50 hover:bg-surface-100 border border-gray-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
          >
            Upload Logo
          </button>
        )}
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleLogoChange} />
      </section>

      {/* Slug confirm dialog */}
      {slugPendingConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-white font-semibold">Change slug?</h3>
            <p className="text-gray-300 text-sm">
              Changing the slug from <span className="font-mono text-white">{org.slug}</span> to{' '}
              <span className="font-mono text-white">{slugValue.trim()}</span> will break any existing
              seller-facing links that use the old URL.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setSlugPendingConfirm(false)}
                className="text-gray-400 hover:text-white text-sm px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={confirmSlugChange}
                className="bg-red-700 hover:bg-red-600 text-white px-4 py-1.5 rounded text-sm"
              >
                Change anyway
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
