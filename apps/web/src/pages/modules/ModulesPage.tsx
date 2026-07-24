import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import type { ModuleItem } from '../../lib/api.types';

export default function ModulesPage() {
  const { orgId, perms } = useOutletContext<{ orgId: string; perms: Set<string> }>();
  const qc = useQueryClient();

  const { data: modules = [], isLoading } = useQuery({
    queryKey: ['modules', orgId],
    queryFn: () => api.modules.list(orgId),
    enabled: !!orgId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.modules.setEnabled(orgId, key, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['modules', orgId] }),
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Modules</h1>
      <div className="space-y-3">
        {modules.map((m: ModuleItem) => (
          <div key={m.key} className="flex items-center justify-between bg-surface-50 rounded-lg p-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-medium text-white">{m.name}</span>
                {m.isCore && <span className="text-xs bg-gray-700 text-gray-300 px-2 py-0.5 rounded-full">Core</span>}
              </div>
              <p className="text-sm text-gray-400 mt-0.5">{m.description}</p>
            </div>
            <div>
              {m.isCore ? (
                <span className="text-xs text-green-400">Always on</span>
              ) : (
                <button
                  disabled={!perms.has('modules:manage') || toggleMutation.isPending}
                  onClick={() => toggleMutation.mutate({ key: m.key, enabled: !m.enabled })}
                  className={`relative w-12 h-6 rounded-full transition ${m.enabled ? 'bg-brand-600' : 'bg-gray-700'} disabled:opacity-50`}
                >
                  <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${m.enabled ? 'left-7' : 'left-1'}`} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
