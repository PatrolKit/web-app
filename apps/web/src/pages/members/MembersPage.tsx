import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import { isActiveNow, timeAgo } from '../../lib/timeAgo';
import type { MemberResponse } from '../../lib/api.types';
import { matchesSearch } from './memberSearch';
import { MemberFormModal, type MemberDraft } from './MemberFormModal';
import MemberImportModal from './MemberImportModal';

type Filter = 'all' | 'cantClockIn' | 'inactive';

/** The form's draft as the API takes it: blanks are absent when adding, cleared when editing. */
function memberInput(d: MemberDraft, editing: boolean) {
  const opt = (v: string) => (v.trim() ? v.trim() : editing ? null : undefined);
  return {
    firstName: d.firstName.trim() || undefined,
    lastName: d.lastName.trim() || undefined,
    email: opt(d.email),
    phone: opt(d.phone),
    nspId: opt(d.nspId),
    patrolLevel: opt(d.patrolLevel),
  };
}

function inviteDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function MembersPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const [showImport, setShowImport] = useState(false);
  /** The member being edited; `'new'` while adding one. */
  const [form, setForm] = useState<MemberResponse | 'new' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [removing, setRemoving] = useState<MemberResponse | null>(null);
  const [editingPermsFor, setEditingPermsFor] = useState<string | null>(null);
  const [draftPerms, setDraftPerms] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  const { data: members = [], isLoading } = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api.members.list(orgId),
    enabled: !!orgId,
  });
  const shown = useMemo(
    () => members.filter((m) =>
      matchesSearch(m, search) &&
      (filter === 'all' || (filter === 'inactive' ? m.inactive : !m.inactive && !m.canClockIn))),
    [members, search, filter],
  );
  const cantClockIn = members.filter((m) => !m.inactive && !m.canClockIn).length;
  const inactiveCount = members.filter((m) => m.inactive).length;

  const { data: allPerms = [] } = useQuery({
    queryKey: ['permissions', orgId],
    queryFn: () => api.members.permissions(orgId),
    enabled: !!orgId && perms.has('permissions:assign'),
  });

  const saveMutation = useMutation({
    mutationFn: (d: MemberDraft) =>
      form === 'new' || form === null
        ? api.members.invite(orgId, { ...memberInput(d, false), permissions: [] })
        : api.members.update(orgId, form.userId, {
            ...memberInput(d, true),
            ...(d.inactive !== form.inactive ? { inactive: d.inactive } : {}),
            ...(d.clearClockPin ? { clearClockPin: true as const } : {}),
          }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members', orgId] }); setForm(null); setFormError(null); },
    onError: (e: Error) => setFormError(e.message),
  });

  const updatePermsMutation = useMutation({
    mutationFn: (userId: string) => api.members.update(orgId, userId, { permissions: draftPerms }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members', orgId] }); setEditingPermsFor(null); },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.members.remove(orgId, userId),
    onSettled: () => { setRemoving(null); void qc.invalidateQueries({ queryKey: ['members', orgId] }); },
  });

  /** What became of each invite sent from this page, by member, until it reloads. */
  const [inviteNotes, setInviteNotes] = useState<Record<string, { ok: boolean; text: string }>>({});
  const sendInviteMutation = useMutation({
    mutationFn: (userId: string) => api.members.sendInvite(orgId, userId),
    onSuccess: (res, userId) => {
      setInviteNotes((n) => ({
        ...n,
        [userId]: res.status === 'sent'
          ? { ok: true, text: `Invite sent to ${res.sentTo}` }
          : { ok: false, text: `Not sent (${res.status}) — outgoing email may be switched off` },
      }));
      void qc.invalidateQueries({ queryKey: ['members', orgId] });
    },
    onError: (err: Error, userId) => setInviteNotes((n) => ({ ...n, [userId]: { ok: false, text: err.message } })),
  });

  function startEditPerms(m: MemberResponse) {
    setEditingPermsFor(m.userId);
    setDraftPerms(m.permissions);
  }

  function togglePerm(key: string) {
    setDraftPerms((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }


  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Members</h1>

      <div className="flex flex-wrap items-center gap-3">
        {perms.has('users:invite') && (
          <button onClick={() => { setFormError(null); setForm('new'); }}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
            Add member
          </button>
        )}
        {perms.has('users:import') && (
          <button onClick={() => setShowImport(true)} className="text-sm text-brand-500 hover:underline">
            Import from a CSV
          </button>
        )}
      </div>

      <div className="space-y-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or phone"
          aria-label="Search members"
          className="w-full max-w-md bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm"
        />
        <div className="flex gap-1" role="group" aria-label="Show">
          {([
            ['all', `All (${members.length})`],
            ['cantClockIn', `Can't clock in (${cantClockIn})`],
            ['inactive', `Inactive (${inactiveCount})`],
          ] as [Filter, string][]).map(([f, label]) => (
            <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f}
              className={`text-sm px-3 py-1.5 rounded ${filter === f ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`}>
              {label}
            </button>
          ))}
        </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500 border-b border-gray-800">
            <th className="py-2 pr-4">Name</th><th className="py-2 pr-4">NSP ID</th><th className="py-2 pr-4">Contact</th>
            <th className="py-2 pr-4">Invited</th><th className="py-2 pr-4">Last active</th><th className="py-2 pr-4">Permissions</th>
            {(perms.has('users:manage') || perms.has('permissions:assign') || perms.has('users:invite')) && <th className="py-2">Actions</th>}
          </tr></thead>
          <tbody>
          {shown.length === 0 && (
            <tr><td colSpan={7} className="py-4 text-gray-500">
              {search.trim() ? `No members match “${search.trim()}”.` : 'No members yet.'}
            </td></tr>
          )}
          {shown.map((m: MemberResponse) => (
            <React.Fragment key={m.userId}>
              <tr className="border-b border-gray-800">
                <td className="py-2 pr-4 text-white">
                  {m.displayName}
                  {m.patrolLevel && <div className="text-xs text-gray-500">{m.patrolLevel}</div>}
                </td>
                <td className="py-2 pr-4 text-gray-300 tabular-nums">
                  {m.nspId ?? (m.clockPinSet ? <span className="text-gray-500 text-xs">PIN set</span> : <span className="text-gray-600">—</span>)}
                </td>
                <td className="py-2 pr-4 text-gray-400">
                  {m.email ?? (!m.phone && <span className="text-gray-600">None</span>)}
                  {m.phone && <div className="text-xs text-gray-500">{m.phone}</div>}
                </td>
                <td className="py-2 pr-4 text-xs whitespace-nowrap">
                  {m.inviteSentAt
                    ? <span className="text-gray-300" title={new Date(m.inviteSentAt).toLocaleString()}>{inviteDate(m.inviteSentAt)}</span>
                    : <span className="text-gray-600">Not yet</span>}
                </td>
                <td className="py-2 pr-4 text-xs whitespace-nowrap"><LastActive member={m} /></td>
                <td className="py-2 pr-4 text-xs text-gray-500 max-w-xs truncate">{m.permissions.join(', ') || '—'}</td>
                <td className="py-2 flex gap-3 items-center flex-wrap">
                  {perms.has('users:manage') && (
                    <button onClick={() => { setFormError(null); setForm(m); }}
                      className="text-xs text-brand-500 hover:underline">Edit</button>
                  )}
                  {/* Where and how to sign in, for someone an administrator
                      added. A sign-in link would expire before it's read. */}
                  {perms.has('users:invite') && m.removedAt === null && (
                    <button
                      onClick={() => sendInviteMutation.mutate(m.userId)}
                      disabled={!m.email || (sendInviteMutation.isPending && sendInviteMutation.variables === m.userId)}
                      title={m.email ? `Email ${m.email} where and how to sign in` : 'This member has no email address'}
                      className="text-xs text-brand-500 hover:underline disabled:opacity-40 disabled:no-underline"
                    >
                      {sendInviteMutation.isPending && sendInviteMutation.variables === m.userId ? 'Sending…' : 'Send invite'}
                    </button>
                  )}
                  {inviteNotes[m.userId] && (
                    <span className={`text-xs ${inviteNotes[m.userId].ok ? 'text-green-400' : 'text-amber-400'}`}>
                      {inviteNotes[m.userId].text}
                    </span>
                  )}
                  {perms.has('permissions:assign') && (
                    <button onClick={() => editingPermsFor === m.userId ? setEditingPermsFor(null) : startEditPerms(m)}
                      className="text-xs text-brand-500 hover:underline">
                      {editingPermsFor === m.userId ? 'Cancel' : 'Edit permissions'}
                    </button>
                  )}
                  {perms.has('users:manage') && (
                    <button onClick={() => setRemoving(m)}
                      className="text-xs text-red-500 hover:underline">Remove</button>
                  )}
                </td>
              </tr>
              {editingPermsFor === m.userId && (
                <tr className="border-b border-gray-800 bg-surface-50">
                  <td colSpan={7} className="px-4 py-3">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-1.5 mb-3">
                      {allPerms.map((p) => (
                        <label key={p.key} className="flex items-center gap-2 text-xs cursor-pointer">
                          <input type="checkbox" checked={draftPerms.includes(p.key)}
                            onChange={() => togglePerm(p.key)}
                            className="accent-brand-600" />
                          <span className="text-gray-300 font-mono">{p.key}</span>
                        </label>
                      ))}
                    </div>
                    <button onClick={() => updatePermsMutation.mutate(m.userId)}
                      disabled={updatePermsMutation.isPending}
                      className="bg-brand-600 hover:bg-brand-700 text-white text-xs px-3 py-1.5 rounded font-medium">
                      Save permissions
                    </button>
                  </td>
                </tr>
              )}
            </React.Fragment>
          ))}</tbody>
        </table>
      </div>
      </div>

      {form && (
        <MemberFormModal
          member={form === 'new' ? null : form}
          busy={saveMutation.isPending}
          error={formError}
          onSave={(d) => saveMutation.mutate(d)}
          onClose={() => setForm(null)}
        />
      )}
      {showImport && (
        <MemberImportModal
          orgId={orgId}
          onClose={() => setShowImport(false)}
          onImported={() => void qc.invalidateQueries({ queryKey: ['members', orgId] })}
        />
      )}
      {removing && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div role="dialog" aria-labelledby="remove-title" className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 id="remove-title" className="text-white font-semibold">Remove {removing.displayName}?</h3>
            <p className="text-gray-300 text-sm">
              They lose their permissions here and come off the iPads' clock-in list. Their time entries and history stay.
              {removing.clockedIn && ` They're clocked in at ${removing.clockedIn.resortName}; this clocks them out.`}
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setRemoving(null)} className="text-gray-400 hover:text-white text-sm px-3 py-1.5">Cancel</button>
              <button onClick={() => removeMutation.mutate(removing.userId)} disabled={removeMutation.isPending}
                className="bg-red-700 hover:bg-red-600 text-white px-4 py-1.5 rounded text-sm">Remove</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * When a member was last active, and whether they're signed in. From their
 * sessions, which renew every 15 minutes of use: "Active now" is a renewal in
 * the last 20 minutes.
 */
function LastActive({ member }: { member: MemberResponse }) {
  const at = member.lastActiveAt ?? null;
  if (!at) return <span className="text-gray-600">Never signed in</span>;
  const title = new Date(at).toLocaleString();
  if (isActiveNow(at)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-green-400" title={title}>
        <span className="h-2 w-2 rounded-full bg-green-400" aria-hidden="true" />
        Active now
      </span>
    );
  }
  return (
    <span title={title}>
      <span className="text-gray-300">{timeAgo(at)}</span>
      <span className="block text-gray-500">{member.signedIn ? 'Signed in' : 'Signed out'}</span>
    </span>
  );
}
