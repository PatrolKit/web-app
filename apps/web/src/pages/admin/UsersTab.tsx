import { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { MutationError } from '../devices/DeviceCredentials';
import type { PlatformOrg, PlatformUser, PlatformUserMembership } from '../../lib/api.types';

const PAGE_SIZE = 25;

/** The org filter's two non-org options, kept apart from real org ids. */
const ANY = '__any__';
const NONE = '__none__';

/**
 * Everyone on the platform.
 *
 * The filter that matters is "no org": a user can hold a verified contact and
 * belong to nothing — they signed in, or were partway through a check-in — and
 * no org-scoped page would ever list them. That is the case this exists for.
 */
export default function UsersTab() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<string>(ANY);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);

  const { data: orgs = [] } = useQuery({
    queryKey: ['admin-orgs'],
    queryFn: () => api.admin.listOrgs(),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', q, scope, page],
    queryFn: () =>
      api.admin.listUsers({
        q: q || undefined,
        orgId: scope !== ANY && scope !== NONE ? scope : undefined,
        membership: scope === NONE ? 'none' : undefined,
        page,
        limit: PAGE_SIZE,
      }),
    // Keeps the table on screen while the next page loads, rather than
    // collapsing to "Loading…" every time a filter moves.
    placeholderData: keepPreviousData,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const act = <T,>(fn: () => Promise<T>) =>
    fn().then(refresh).catch((e: Error) => setError(e.message));

  const addMembership = useMutation({
    mutationFn: ({ userId, orgId }: { userId: string; orgId: string }) =>
      api.admin.addMembership(userId, orgId),
  });

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function applySearch(e: React.FormEvent) {
    e.preventDefault();
    setQ(search.trim());
    setPage(1);
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-white font-medium">Users</h2>
        <p className="text-xs text-gray-500">
          Everyone on the platform, including people who belong to no organization yet — a
          seller partway through a check-in, or someone who signed in before being added
          anywhere.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <form onSubmit={applySearch} className="flex gap-2 flex-1 min-w-[16rem]">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or phone"
            className="flex-1 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
          />
          <button
            type="submit"
            className="bg-surface-100 hover:bg-surface-200 border border-gray-700 text-gray-200 px-3 py-2 rounded text-sm"
          >
            Search
          </button>
        </form>
        <select
          value={scope}
          onChange={(e) => { setScope(e.target.value); setPage(1); }}
          className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm"
        >
          <option value={ANY}>All users</option>
          <option value={NONE}>No organization</option>
          {orgs.map((o: PlatformOrg) => (
            <option key={o.id} value={o.id}>{o.name}</option>
          ))}
        </select>
      </div>

      {error && <MutationError error={new Error(error)} />}

      {isLoading ? (
        <p className="text-gray-400 text-sm">Loading…</p>
      ) : (
        <>
          <p className="text-xs text-gray-500">
            {total} {total === 1 ? 'user' : 'users'}
          </p>

          <div className="space-y-2">
            {data?.users.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                orgs={orgs}
                onAdd={(orgId) => act(() => addMembership.mutateAsync({ userId: u.id, orgId }))}
                onRemove={(membershipId) =>
                  act(() => api.admin.removeMembership(u.id, membershipId))
                }
                onDelete={() => act(() => api.admin.deleteUser(u.id))}
              />
            ))}
            {data?.users.length === 0 && (
              <p className="text-gray-500 text-sm">No users match that.</p>
            )}
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="text-xs text-gray-400 hover:text-white disabled:opacity-30"
              >
                ← Previous
              </button>
              <span className="text-xs text-gray-500">Page {page} of {pages}</span>
              <button
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
                disabled={page >= pages}
                className="text-xs text-gray-400 hover:text-white disabled:opacity-30"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function UserRow({
  user,
  orgs,
  onAdd,
  onRemove,
  onDelete,
}: {
  user: PlatformUser;
  orgs: PlatformOrg[];
  onAdd: (orgId: string) => void;
  onRemove: (membershipId: string) => void;
  onDelete: () => void;
}) {
  const [adding, setAdding] = useState(false);

  const current = user.memberships.filter((m) => !m.removed);
  const former = user.memberships.filter((m) => m.removed);
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');

  return (
    <div className="bg-surface-50 rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-white font-medium">
            {/* A walk-in known only by a phone number has no name at all. */}
            {name || <span className="text-gray-500 italic">No name</span>}
            {user.isSuperAdmin && (
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-brand-900 text-brand-300">
                Super admin
              </span>
            )}
          </p>
          <p className="text-xs text-gray-500">
            <Contact value={user.email} verified={user.emailVerified} />
            {user.email && user.phone && ' · '}
            <Contact value={user.phone} verified={user.phoneVerified} />
            {!user.email && !user.phone && 'No contact on file'}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setAdding((v) => !v)}
            className="text-xs text-brand-500 hover:underline"
          >
            Add to org
          </button>
          <button
            onClick={() => {
              if (window.confirm(
                `Delete ${name || 'this user'}?\n\n` +
                  'This removes the person entirely, along with their memberships, seller ' +
                  'profiles and any items consigned under them. It cannot be undone.',
              )) onDelete();
            }}
            className="text-xs text-red-500 hover:underline"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {current.map((m) => (
          <OrgChip key={m.id} membership={m} onRemove={() => onRemove(m.id)} />
        ))}
        {former.map((m) => (
          <OrgChip key={m.id} membership={m} />
        ))}
        {current.length === 0 && former.length === 0 && (
          <span className="text-xs text-amber-500">Belongs to no organization</span>
        )}
        {current.length === 0 && former.length > 0 && (
          <span className="text-xs text-amber-500">No current organization</span>
        )}
      </div>

      {adding && (
        <div className="flex gap-2 pt-1">
          <select
            defaultValue=""
            onChange={(e) => { if (e.target.value) { onAdd(e.target.value); setAdding(false); } }}
            className="bg-surface-100 border border-gray-700 rounded px-2 py-1 text-xs text-white"
          >
            <option value="" disabled>Pick an organization</option>
            {orgs
              .filter((o) => !current.some((m) => m.orgId === o.id))
              .map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
          </select>
          <button onClick={() => setAdding(false)} className="text-xs text-gray-500 hover:underline">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/** A contact, and whether its owner has actually proved they hold it. */
function Contact({ value, verified }: { value: string | null; verified: boolean }) {
  if (!value) return null;
  return (
    <span className={verified ? 'text-gray-400' : 'text-gray-600'} title={verified ? 'Verified' : 'Unverified claim'}>
      {value}
      {!verified && ' (unverified)'}
    </span>
  );
}

function OrgChip({
  membership,
  onRemove,
}: {
  membership: PlatformUserMembership;
  onRemove?: () => void;
}) {
  return (
    <span
      className={`text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1.5 ${
        membership.removed ? 'bg-surface-100 text-gray-500 line-through' : 'bg-surface-100 text-gray-300'
      }`}
      title={membership.removed ? 'Removed from this organization' : undefined}
    >
      {membership.orgName}
      {onRemove && (
        <button
          onClick={() => {
            if (window.confirm(`Remove them from ${membership.orgName}?`)) onRemove();
          }}
          className="text-gray-500 hover:text-red-400"
          aria-label={`Remove from ${membership.orgName}`}
        >
          ×
        </button>
      )}
    </span>
  );
}
