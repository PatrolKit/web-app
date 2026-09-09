import { useState } from 'react';
import { useOutletContext, Navigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import DevicePinCard from '../../components/DevicePinCard';
import type { SkiSwapContext } from './SkiSwapLayout';

export default function AdministrationPage() {
  const { orgId, perms } = useOutletContext<SkiSwapContext>();
  const qc = useQueryClient();
  const [accessToken, setAccessToken] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Every hook below runs unconditionally: React matches hooks by call order, so
  // returning early above them would change the count between renders the moment
  // permissions resolve. The redirect happens after them instead, and the query
  // is gated on the same permission so a non-admin never issues a request they
  // would be refused.
  const isAdmin = perms.has('ski_swap:admin');

  const { data: config, isLoading } = useQuery({
    queryKey: ['ski-swap/config', orgId],
    queryFn: () => api.skiSwap.getConfig(orgId).catch(() => null),
    enabled: !!orgId && isAdmin,
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
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/config', orgId] });
      qc.invalidateQueries({ queryKey: ['ski-swap/status', orgId] });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => api.skiSwap.testConnection(orgId),
    onSuccess: (res) => setTestResult(res),
    onError: () => setTestResult({ success: false, message: 'Connection failed' }),
  });

  if (!isAdmin) return <Navigate to="/dashboard/ski-swap" replace />;
  if (isLoading) return <p className="text-gray-400">Loading…</p>;

  return (
    <div className="max-w-lg space-y-8">
      <DevicePinCard
        queryKey={['ski-swap/device-pin', orgId]}
        get={() => api.skiSwap.getDevicePin(orgId)}
        set={(devicePin) => api.skiSwap.setDevicePin(orgId, devicePin)}
        deviceLabel="check-in iPads"
      />

      <LabelsPerItemSection orgId={orgId} />

      <AcceptingItemsSection orgId={orgId} />

      <div className="space-y-6">
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

      {/* Danger zone */}
      <div className="border border-red-900 rounded-lg p-4 space-y-3">
        <h3 className="text-red-400 font-medium text-sm uppercase tracking-wide">Danger Zone</h3>
        <p className="text-gray-400 text-sm">
          Permanently delete all items and sellers for this organisation from the PatrolKit database.
          This does <strong className="text-white">not</strong> remove anything from Square.
        </p>
        <label className="block">
          <span className="text-gray-400 text-xs">Type <span className="text-white font-mono">RESET</span> to confirm</span>
          <input
            value={resetConfirm}
            onChange={(e) => setResetConfirm(e.target.value)}
            placeholder="RESET"
            className="mt-1 w-full bg-surface-100 border border-red-900 rounded px-3 py-2 text-sm text-white font-mono"
          />
        </label>
        <ResetButton orgId={orgId} disabled={resetConfirm !== 'RESET'} onDone={() => { setResetConfirm(''); qc.invalidateQueries(); }} />
      </div>
      </div>
    </div>
  );
}

function LabelsPerItemSection({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['ski-swap/settings', orgId],
    queryFn: () => api.skiSwap.getSettings(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: (labelsPerItem: number) => api.skiSwap.updateSettings(orgId, { labelsPerItem }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/settings', orgId] }),
  });
  const current = settings?.labelsPerItem ?? 1;

  return (
    <div className="space-y-3">
      <h2 className="text-white font-semibold">Printing</h2>
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-white">Labels per item</p>
            <p className="text-xs text-gray-500 mt-0.5">Number of price tag labels printed each time an item is printed</p>
          </div>
          <div className="flex items-center gap-2">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                onClick={() => mutation.mutate(n)}
                disabled={mutation.isPending}
                className={`w-9 h-9 rounded text-sm font-medium transition ${current === n ? 'bg-brand-600 text-white' : 'bg-surface-100 text-gray-300 hover:bg-surface-200'} disabled:opacity-40`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Whether staff have to scan a self check-in item before it can sell.
 *
 * The setting is read once, at check-in, and its answer stored on the item, so
 * turning it on does nothing to what is already on the floor. That is stated on
 * the control rather than left for an administrator to discover: someone who
 * switches it on mid-swap expecting the floor to empty is otherwise surprised
 * by inventory they thought they had just held back.
 */
function AcceptingItemsSection({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['ski-swap/settings', orgId],
    queryFn: () => api.skiSwap.getSettings(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });
  const mutation = useMutation({
    mutationFn: (requireConsignmentScan: boolean) =>
      api.skiSwap.updateSettings(orgId, { requireConsignmentScan }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ski-swap/settings', orgId] }),
  });
  const on = settings?.requireConsignmentScan ?? false;

  return (
    <div className="space-y-3">
      <h2 className="text-white font-semibold">Accepting items</h2>
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm text-white">Staff must scan self check-in items before they sell</p>
            <p className="text-xs text-gray-500">
              A seller who checks themselves in tags their items and waits. Nothing they entered
              reaches the register until a staff member scans it.
            </p>
            <p className="text-xs text-gray-500">
              Applies to items checked in from now on — anything already on the floor stays there.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Staff must scan self check-in items before they sell"
            onClick={() => mutation.mutate(!on)}
            disabled={mutation.isPending || settings === undefined}
            className={`shrink-0 mt-0.5 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-brand-600' : 'bg-surface-200'}`}
          >
            <span
              className={`block w-5 h-5 bg-white rounded-full transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`}
            />
          </button>
        </div>
        {mutation.isError && (
          <p className="text-xs text-red-400">
            {mutation.error instanceof ApiError ? mutation.error.message : 'Could not save that.'}
          </p>
        )}
      </div>
    </div>
  );
}

function ResetButton({ orgId, disabled, onDone }: { orgId: string; disabled: boolean; onDone: () => void }) {
  const mutation = useMutation({
    mutationFn: () => api.skiSwap.resetOrgData(orgId),
    onSuccess: (result) => {
      alert(`Reset complete. Deleted ${result.deletedItems} item(s) and ${result.deletedSellers} seller(s).`);
      onDone();
    },
  });
  return (
    <div className="space-y-1">
      <button
        onClick={() => mutation.mutate()}
        disabled={disabled || mutation.isPending}
        className="bg-red-700 hover:bg-red-800 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
      >
        {mutation.isPending ? 'Resetting…' : 'Delete all items & sellers'}
      </button>
      {mutation.isError && (
        <p className="text-red-400 text-xs">{mutation.error instanceof ApiError ? mutation.error.message : 'Reset failed'}</p>
      )}
    </div>
  );
}
