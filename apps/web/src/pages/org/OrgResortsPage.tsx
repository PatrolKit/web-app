import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { ResortResponse } from '../../lib/api.types';
import type { OrgAdminContext } from './OrgAdminLayout';
import ResortFormModal from './ResortFormModal';

export default function OrgResortsPage() {
  const { orgId } = useOutletContext<OrgAdminContext>();
  const qc = useQueryClient();

  const [editing, setEditing] = useState<ResortResponse | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ResortResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: resorts = [], isLoading } = useQuery({
    queryKey: ['resorts', orgId],
    queryFn: () => api.orgs.listResorts(orgId),
    enabled: !!orgId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.orgs.deleteResort(orgId, id),
    onSuccess: () => {
      setConfirmDelete(null);
      setError(null);
      qc.invalidateQueries({ queryKey: ['resorts', orgId] });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-gray-400 text-sm max-w-2xl">
          The places this organization patrols. Time tracking records every shift against a
          resort, and each resort's time zone — worked out from its address — is what the
          automatic clock-out sweep runs on.
        </p>
        <button
          onClick={() => setEditing('new')}
          className="shrink-0 bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 rounded text-sm"
        >
          Add resort
        </button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {isLoading ? (
        <p className="text-gray-400">Loading…</p>
      ) : resorts.length === 0 ? (
        <p className="text-gray-500 text-sm bg-surface-100 rounded-lg p-6 text-center">
          No resorts yet.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-gray-500 border-b border-gray-800">
            <tr>
              <th className="text-left py-2 font-medium">Name</th>
              <th className="text-left py-2 font-medium">Address</th>
              <th className="text-left py-2 font-medium">Time zone</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {resorts.map((r) => (
              <tr key={r.id} className="border-b border-gray-900">
                <td className="py-2 text-white align-top">{r.name}</td>
                <td className="py-2 text-gray-400 align-top">
                  {formatAddress(r) ?? <span className="text-gray-600">—</span>}
                </td>
                <td className="py-2 text-gray-400 align-top">{r.timeZone}</td>
                <td className="py-2 text-right align-top space-x-3 whitespace-nowrap">
                  <button
                    onClick={() => setEditing(r)}
                    className="text-gray-400 hover:text-white text-xs"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => { setError(null); setConfirmDelete(r); }}
                    className="text-red-400 hover:text-red-300 text-xs"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <ResortFormModal
          orgId={orgId}
          resort={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['resorts', orgId] });
          }}
        />
      )}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-6 max-w-sm w-full space-y-4">
            <h3 className="text-white font-semibold">Delete {confirmDelete.name}?</h3>
            <p className="text-gray-300 text-sm">
              It will stop appearing anywhere you pick a resort. Shifts already recorded there
              stay in the hours report.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-gray-400 hover:text-white text-sm px-3 py-1.5"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(confirmDelete.id)}
                disabled={deleteMutation.isPending}
                className="bg-red-700 hover:bg-red-600 disabled:opacity-40 text-white px-4 py-1.5 rounded text-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatAddress(r: ResortResponse): string | null {
  const cityLine = [r.city, r.state].filter(Boolean).join(', ');
  const parts = [r.street, [cityLine, r.zip].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}
