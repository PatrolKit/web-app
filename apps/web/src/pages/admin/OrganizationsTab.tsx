import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { MutationError } from '../devices/DeviceCredentials';
import type { PlatformOrg } from '../../lib/api.types';
import { slugFrom } from './orgSlug';

/** Every organization on the platform, and the form that adds one. */
export default function OrganizationsTab() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  /** The slug follows the name until someone types in it. */
  const [slugEdited, setSlugEdited] = useState(false);
  /** What happened to the last org's owner, said once the form closes. */
  const [created, setCreated] = useState<string | null>(null);

  const { data: orgs = [], isLoading } = useQuery({
    queryKey: ['admin-orgs'],
    queryFn: () => api.admin.listOrgs(),
  });

  const createMutation = useMutation({
    mutationFn: () => api.admin.createOrg({ name, slug, ownerEmail }),
    onSuccess: (org) => {
      qc.invalidateQueries({ queryKey: ['admin-orgs'] });
      const who = org.owner.created ? `A PatrolKit account was made for ${org.owner.email}` : `${org.owner.email} already had a PatrolKit account`;
      setCreated(`${org.name} created. ${who}, and they're its owner. ${org.owner.invite === 'sent'
        ? 'The invite email went to them.'
        : 'No invite email went (outbound mail is off, or it failed): tell them to sign in with that email.'}`);
      setName(''); setSlug(''); setOwnerEmail(''); setSlugEdited(false);
      setShowForm(false);
    },
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-white font-medium">Organizations</h2>
        <p className="text-xs text-gray-500">
          Every organization on the platform. Creating one also creates its first owner, who
          gets every permission and can invite the rest from the org&apos;s own Members page.
        </p>
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => { setShowForm(true); setCreated(null); createMutation.reset(); }}
          className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium"
        >
          + Add organization
        </button>
      </div>

      {created && !showForm && (
        <p className="text-sm text-green-300 bg-green-900/20 border border-green-800 rounded px-3 py-2">{created}</p>
      )}

      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3"
        >
          <h3 className="text-white font-medium">New organization</h3>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => { setName(e.target.value); if (!slugEdited) setSlug(slugFrom(e.target.value)); }}
              placeholder="e.g. Mountain Ski Patrol"
              required
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Slug</span>
            <input
              value={slug}
              onChange={(e) => { setSlug(e.target.value.toLowerCase()); setSlugEdited(e.target.value !== ''); }}
              placeholder="mountain-ski-patrol"
              pattern="[a-z0-9-]+"
              required
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm font-mono"
            />
            <span className="block text-xs text-gray-500 mt-1">
              Appears in seller links. Lowercase letters, numbers and hyphens. Filled in from the name until you change it.
            </span>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Owner email</span>
            <span className="block text-xs text-gray-500 mb-1">They needn't have a PatrolKit account: one is made, and they're emailed an invite.</span>
            <input
              value={ownerEmail}
              onChange={(e) => setOwnerEmail(e.target.value)}
              placeholder="owner@example.com"
              type="email"
              required
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
            />
          </label>
          <MutationError error={createMutation.error} />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => { setShowForm(false); setSlugEdited(false); createMutation.reset(); }}
              className="text-sm text-gray-400 hover:text-white px-3 py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending}
              className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm disabled:opacity-40"
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      )}

      <div className="space-y-2">
        {orgs.map((o: PlatformOrg) => (
          <div key={o.id} className="bg-surface-50 rounded-lg p-4 flex items-center justify-between">
            <div>
              <span className="font-medium text-white">{o.name}</span>
              <span className="ml-2 text-xs text-gray-500 font-mono">/{o.slug}</span>
              <span
                className={`ml-2 text-xs px-2 py-0.5 rounded-full ${
                  o.status === 'active' ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-400'
                }`}
              >
                {o.status}
              </span>
            </div>
            <span className="text-xs text-gray-600">
              {new Date(o.createdAt).toLocaleDateString()}
            </span>
          </div>
        ))}
        {orgs.length === 0 && <p className="text-gray-500 text-sm">No organizations yet.</p>}
      </div>
    </section>
  );
}
