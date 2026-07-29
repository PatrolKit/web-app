import { useState } from 'react';
import { useOutletContext, Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import type { SkiSwapContext } from './SkiSwapLayout';

export default function SquareConfigPage() {
  const { orgId, perms } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [accessToken, setAccessToken] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showForm, setShowForm] = useState(false);

  if (!perms.has('ski_swap:admin')) return <Navigate to="/dashboard/ski-swap" replace />;

  const { data: config, isLoading } = useQuery({
    queryKey: ['ski-swap/config', orgId],
    queryFn: () => api.skiSwap.getConfig(orgId).catch(() => null),
    enabled: !!orgId,
  });

  const upsertMutation = useMutation({
    mutationFn: () => api.skiSwap.upsertConfig(orgId, { accessToken, environment: 'production' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/config', orgId] });
      qc.invalidateQueries({ queryKey: ['ski-swap/status', orgId] });
      setShowForm(false);
      setAccessToken('');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.skiSwap.deleteConfig(orgId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/config', orgId] });
      qc.invalidateQueries({ queryKey: ['ski-swap/status', orgId] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.skiSwap.testConnection(orgId),
    onSuccess: (res) => setTestResult(res),
    onError: () => setTestResult({ success: false, message: 'Connection failed' }),
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-white font-semibold">Square API Configuration</h2>

      {!config && (
        <div className="flex items-start gap-3 bg-yellow-900/30 border border-yellow-700 rounded-lg p-4">
          <span className="text-yellow-400 text-lg leading-none">⚠</span>
          <p className="text-yellow-200 text-sm">
            Square credentials are required before this module can be used. Configure them below.
          </p>
        </div>
      )}

      {config && !showForm && (
        <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="text-gray-400">Access Token</span>
            <span className="text-gray-500">***</span>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={() => testMutation.mutate()} disabled={testMutation.isPending}
              className="bg-surface-100 hover:bg-surface-200 text-white text-sm px-3 py-1.5 rounded">
              Test Connection
            </button>
            <button onClick={() => setShowForm(true)} className="text-sm text-brand-500 hover:underline">
              Update token
            </button>
            <button onClick={() => { if (confirm('Remove Square configuration?')) deleteMutation.mutate(); }}
              className="text-sm text-red-500 hover:underline ml-auto">Remove</button>
          </div>
          {testResult && (
            <p className={`text-sm ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
              {testResult.success ? '✓' : '✗'} {testResult.message}
            </p>
          )}
        </div>
      )}

      {(!config || showForm) && (
        <form onSubmit={(e) => { e.preventDefault(); upsertMutation.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-4">
          <h3 className="text-white font-medium">{config ? 'Update Token' : 'Connect Square'}</h3>
          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Access Token</span>
            <input
              required
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="EAAAlXXX…"
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={upsertMutation.isPending || !accessToken}
              className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
            >
              Save
            </button>
            {showForm && (
              <button type="button" onClick={() => { setShowForm(false); setAccessToken(''); }}
                className="text-gray-400 hover:text-white text-sm px-3 py-2">Cancel</button>
            )}
          </div>
          {upsertMutation.isError && (
            <p className="text-red-400 text-sm">
              {upsertMutation.error instanceof ApiError ? upsertMutation.error.message : 'Save failed'}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
