import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import type { PlatformOrg } from '../../lib/api.types';

export default function AdminPage() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [err, setErr] = useState('');

  const { data: orgs = [], isLoading } = useQuery({
    enabled: !!user?.isSuperAdmin,
    queryKey: ['admin-orgs'],
    queryFn: () => api.admin.listOrgs(),
  });

  const createMutation = useMutation({
    mutationFn: () => api.admin.createOrg({ name, slug, ownerEmail }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
      setName(''); setSlug(''); setOwnerEmail(''); setErr('');
    },
    onError: (e: Error) => setErr(e.message),
  });

  if (!user?.isSuperAdmin) return <p className="text-red-400">Access denied.</p>;
  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-white">Platform Admin</h1>

      <div className="bg-surface-50 rounded-xl p-6 space-y-4">
        <h2 className="font-semibold text-white">Create Organization</h2>
        <form onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }} className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" required
            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          <input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="slug-here" required
            pattern="[a-z0-9-]+"
            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="owner@example.com" type="email" required
            className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          {err && <p className="text-red-400 text-sm">{err}</p>}
          <button type="submit" disabled={createMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm">
            Create
          </button>
        </form>
      </div>

      <div className="space-y-3">
        {orgs.map((o: PlatformOrg) => (
          <div key={o.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <span className="font-medium text-white">{o.name}</span>
              <span className="ml-2 text-xs text-gray-500">/{o.slug}</span>
              <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${o.status === 'active' ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-400'}`}>{o.status}</span>
            </div>
            <span className="text-xs text-gray-600">{new Date(o.createdAt).toLocaleDateString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
