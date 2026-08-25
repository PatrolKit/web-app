import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import type { MemberResponse, ImportOutcome } from '../../lib/api.types';

/** The invite form takes one name field; the API stores the parts separately. */
function splitInviteName(raw: string): { firstName?: string; lastName?: string } {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

export default function MembersPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [sendInvites, setSendInvites] = useState(false);
  const [importResults, setImportResults] = useState<ImportOutcome[] | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [editingPermsFor, setEditingPermsFor] = useState<string | null>(null);
  const [draftPerms, setDraftPerms] = useState<string[]>([]);

  const { data: members = [], isLoading } = useQuery({
    queryKey: ['members', orgId],
    queryFn: () => api.members.list(orgId),
    enabled: !!orgId,
  });

  const { data: allPerms = [] } = useQuery({
    queryKey: ['permissions', orgId],
    queryFn: () => api.members.permissions(orgId),
    enabled: !!orgId && perms.has('permissions:assign'),
  });

  const inviteMutation = useMutation({
    mutationFn: () => api.members.invite(orgId, { email: inviteEmail, ...splitInviteName(inviteName), permissions: [] }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members', orgId] }); setInviteEmail(''); setInviteName(''); },
  });

  const updatePermsMutation = useMutation({
    mutationFn: (userId: string) => api.members.update(orgId, userId, { permissions: draftPerms }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['members', orgId] }); setEditingPermsFor(null); },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.members.remove(orgId, userId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['members', orgId] }),
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

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!csvFile) return;
    const result = await api.members.importCsv(orgId, csvFile, sendInvites);
    setImportResults(result.data ?? []);
  }

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Members</h1>

      {perms.has('users:invite') && (
        <form onSubmit={(e) => { e.preventDefault(); inviteMutation.mutate(); }} className="flex gap-2">
          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="email@example.com" type="email" required
            className="flex-1 bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          <input value={inviteName} onChange={(e) => setInviteName(e.target.value)}
            placeholder="Name (optional)"
            className="flex-1 bg-surface-50 border border-gray-700 rounded px-3 py-2 text-white text-sm" />
          <button type="submit" disabled={inviteMutation.isPending}
            className="bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm font-medium">
            Invite
          </button>
        </form>
      )}

      {perms.has('users:import') && (
        <div>
          <button onClick={() => setShowImport(!showImport)} className="text-sm text-brand-500 hover:underline">
            {showImport ? 'Hide' : 'Bulk CSV import'}
          </button>
          {showImport && (
            <form onSubmit={handleImport} className="mt-3 space-y-2">
              <input type="file" accept=".csv" onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                className="text-sm text-gray-300" />
              <label className="flex items-center gap-2 text-sm text-gray-400">
                <input type="checkbox" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} />
                Send onboarding emails
              </label>
              <button type="submit" disabled={!csvFile}
                className="bg-surface-100 hover:bg-surface-200 text-white text-sm px-3 py-1.5 rounded">
                Import
              </button>
            </form>
          )}
          {importResults && (
            <div className="mt-4 overflow-x-auto">
              <table className="text-sm w-full">
                <thead><tr className="text-left text-gray-500">
                  <th className="py-1 pr-4">Row</th><th className="py-1 pr-4">Email</th>
                  <th className="py-1 pr-4">Outcome</th><th className="py-1">Error</th>
                </tr></thead>
                <tbody>{importResults.map((r) => (
                  <tr key={r.row} className="border-t border-gray-800">
                    <td className="py-1 pr-4 text-gray-400">{r.row}</td>
                    <td className="py-1 pr-4 text-white">{r.email}</td>
                    <td className={`py-1 pr-4 ${r.outcome === 'error' ? 'text-red-400' : 'text-green-400'}`}>{r.outcome}</td>
                    <td className="py-1 text-red-400 text-xs">{r.error}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500 border-b border-gray-800">
            <th className="py-2 pr-4">Name</th><th className="py-2 pr-4">Email</th>
            <th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Permissions</th>
            {(perms.has('users:manage') || perms.has('permissions:assign')) && <th className="py-2">Actions</th>}
          </tr></thead>
          <tbody>{members.map((m: MemberResponse) => (
            <React.Fragment key={m.userId}>
              <tr className="border-b border-gray-800">
                <td className="py-2 pr-4 text-white">{m.displayName}</td>
                <td className="py-2 pr-4 text-gray-400">{m.email}</td>
                <td className="py-2 pr-4">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${m.removedAt === null ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-400'}`}>{m.removedAt === null ? 'active' : 'removed'}</span>
                </td>
                <td className="py-2 pr-4 text-xs text-gray-500 max-w-xs truncate">{m.permissions.join(', ') || '—'}</td>
                <td className="py-2 flex gap-3">
                  {perms.has('permissions:assign') && (
                    <button onClick={() => editingPermsFor === m.userId ? setEditingPermsFor(null) : startEditPerms(m)}
                      className="text-xs text-brand-500 hover:underline">
                      {editingPermsFor === m.userId ? 'Cancel' : 'Edit permissions'}
                    </button>
                  )}
                  {perms.has('users:manage') && (
                    <button onClick={() => removeMutation.mutate(m.userId)}
                      className="text-xs text-red-500 hover:underline">Remove</button>
                  )}
                </td>
              </tr>
              {editingPermsFor === m.userId && (
                <tr className="border-b border-gray-800 bg-surface-50">
                  <td colSpan={5} className="px-4 py-3">
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
  );
}
