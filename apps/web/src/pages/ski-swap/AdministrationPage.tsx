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

      <PayoutsSection orgId={orgId} />

      <PayPalSection orgId={orgId} />

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
          Permanently delete all items and sellers for this organization from the PatrolKit database.
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

/**
 * The patrol's cut, and the floor under an electronic payout (Plan 25 §3, §7).
 *
 * A percentage, everywhere. Basis points are how the server does the
 * arithmetic and nobody using this needs to know the phrase. Saved on blur and
 * on Enter rather than per keystroke — "2" is a valid percentage on the way to
 * typing "20", and saving it would be saving a number nobody meant.
 */
function PayoutsSection({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ['ski-swap/settings', orgId],
    queryFn: () => api.skiSwap.getSettings(orgId),
    enabled: !!orgId,
    staleTime: 60_000,
  });

  const [percent, setPercent] = useState<string | null>(null);
  const [minimum, setMinimum] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (data: { commissionPercent?: string; payoutMinimumCents?: number }) =>
      api.skiSwap.updateSettings(orgId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/settings', orgId] });
      setPercent(null);
      setMinimum(null);
    },
  });

  // The stored value until somebody starts typing, then theirs. Without this
  // the field fights the user every time the query refetches.
  const shownPercent = percent ?? (settings ? settings.commissionPercent.replace('%', '') : '');
  const shownMinimum =
    minimum ?? (settings ? (settings.payoutMinimumCents / 100).toFixed(2) : '');

  function savePercent() {
    if (percent === null || !settings) return;
    if (percent.trim() === settings.commissionPercent.replace('%', '')) { setPercent(null); return; }
    mutation.mutate({ commissionPercent: percent.trim() });
  }

  function saveMinimum() {
    if (minimum === null || !settings) return;
    const cents = Math.round(Number(minimum) * 100);
    if (!Number.isFinite(cents) || cents < 0) { setMinimum(null); return; }
    if (cents === settings.payoutMinimumCents) { setMinimum(null); return; }
    mutation.mutate({ payoutMinimumCents: cents });
  }

  // What the current cut does to a round number, worked out the same way the
  // server works it out, so the percentage is not the only thing an
  // administrator has to reason about. On $100.00 — 10,000 cents — the cut in
  // cents happens to equal the basis points, which is the arithmetic, not a
  // shortcut around it.
  const HUNDRED_DOLLARS_CENTS = 10_000;
  const bps = settings?.commissionBasisPoints ?? 0;
  const exampleCut = Math.round((HUNDRED_DOLLARS_CENTS * bps) / 10_000);

  return (
    <div className="space-y-3">
      <h2 className="text-white font-semibold">Payouts</h2>
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm text-white">The patrol's share</p>
            <p className="text-xs text-gray-500">
              Taken off every seller's total before they are paid. Up to two decimal places.
            </p>
            {settings && (
              <p className="text-xs text-gray-500">
                On a $100.00 sale the patrol keeps{' '}
                <span className="text-gray-300">${(exampleCut / 100).toFixed(2)}</span> and the
                seller gets{' '}
                <span className="text-gray-300">
                  ${((HUNDRED_DOLLARS_CENTS - exampleCut) / 100).toFixed(2)}
                </span>.
              </p>
            )}
          </div>
          <div className="relative shrink-0">
            <input
              inputMode="decimal"
              value={shownPercent}
              onChange={(e) => setPercent(e.target.value)}
              onBlur={savePercent}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              aria-label="The patrol's share, as a percentage"
              className="w-24 bg-surface-100 border border-gray-700 rounded pl-3 pr-7 py-2 text-sm text-white text-right"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">%</span>
          </div>
        </div>

        <div className="flex items-start justify-between gap-4 border-t border-gray-800 pt-4">
          <div className="space-y-1">
            <p className="text-sm text-white">Smallest payout worth sending</p>
            <p className="text-xs text-gray-500">
              A PayPal or Venmo payout under this is held for review rather than sent. Checks are
              not affected.
            </p>
          </div>
          <div className="relative shrink-0">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">$</span>
            <input
              inputMode="decimal"
              value={shownMinimum}
              onChange={(e) => setMinimum(e.target.value)}
              onBlur={saveMinimum}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              aria-label="Smallest payout worth sending, in dollars"
              className="w-24 bg-surface-100 border border-gray-700 rounded pl-7 pr-3 py-2 text-sm text-white text-right"
            />
          </div>
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

/**
 * PayPal credentials, beside Square's (Plan 25 §6).
 *
 * The secret is write-only. There is no field for it in the response at all, so
 * this screen can say whether one is stored and nothing more — changing it
 * means typing a new one, which is the same bargain Square's token makes.
 */
function PayPalSection({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [webhookId, setWebhookId] = useState('');
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('sandbox');
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const { data: config } = useQuery({
    queryKey: ['ski-swap/paypal-config', orgId],
    queryFn: () => api.skiSwap.getPayPalConfig(orgId).catch(() => null),
    enabled: !!orgId,
  });

  const save = useMutation({
    mutationFn: () =>
      api.skiSwap.upsertPayPalConfig(orgId, {
        clientId, clientSecret, environment, webhookId: webhookId || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ski-swap/paypal-config', orgId] });
      setShowForm(false);
      setClientId(''); setClientSecret(''); setWebhookId('');
      setTestResult(null);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.skiSwap.deletePayPalConfig(orgId),
    onSettled: () => qc.invalidateQueries({ queryKey: ['ski-swap/paypal-config', orgId] }),
  });

  const test = useMutation({
    mutationFn: () => api.skiSwap.testPayPalConnection(orgId),
    onSuccess: setTestResult,
    onError: () => setTestResult({ success: false, message: 'Could not reach PayPal' }),
  });

  function openForm() {
    setClientId(config?.clientId ?? '');
    setWebhookId(config?.webhookId ?? '');
    setEnvironment(config?.environment ?? 'sandbox');
    setClientSecret('');
    setShowForm(true);
  }

  return (
    <div className="space-y-3">
      <h2 className="text-white font-semibold">PayPal Payouts</h2>

      {config && !showForm && (
        <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
          {/* Sandbox or live is the single most consequential thing on this
              card, so it is stated rather than tucked into a form. */}
          {config.environment === 'live' ? (
            <p className="inline-flex items-center gap-2 text-xs text-amber-300 bg-amber-500/10 border border-amber-700/50 rounded px-2 py-1">
              Live — payouts from this organization move real money
            </p>
          ) : (
            <p className="inline-flex items-center gap-2 text-xs text-gray-400 bg-surface-100 border border-gray-700 rounded px-2 py-1">
              Sandbox — nothing sent from here reaches anybody
            </p>
          )}

          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <span className="text-gray-400">Client ID</span>
            <span className="text-gray-300 font-mono text-xs break-all">{config.clientId}</span>
            <span className="text-gray-400">Secret</span>
            <span className="text-gray-500">{config.hasSecret ? 'Stored' : 'Not set'}</span>
            <span className="text-gray-400">Webhook</span>
            <span className={config.webhookId ? 'text-gray-500' : 'text-amber-400'}>
              {config.webhookId ?? 'Not registered'}
            </span>
          </div>

          {!config.webhookId && (
            <p className="text-xs text-amber-300/80">
              Without a webhook, payout results have to be fetched by hand. Register one in your
              PayPal dashboard pointing at{' '}
              <span className="font-mono break-all">{`${window.location.origin}/api/v1/webhooks/paypal/${orgId}`}</span>{' '}
              and paste its ID here.
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button onClick={() => test.mutate()} disabled={test.isPending}
              className="bg-surface-100 hover:bg-surface-200 text-white text-sm px-3 py-1.5 rounded disabled:opacity-40">
              {test.isPending ? 'Testing…' : 'Test connection'}
            </button>
            <button onClick={openForm} className="text-sm text-brand-500 hover:underline">
              Update credentials
            </button>
            <button
              onClick={() => { if (confirm('Remove PayPal configuration? Payouts will stop working.')) remove.mutate(); }}
              className="text-sm text-red-500 hover:underline ml-auto"
            >
              Remove
            </button>
          </div>

          {testResult && (
            <p className={`text-sm ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
              {testResult.success ? '✓' : '✗'} {testResult.message}
            </p>
          )}
        </div>
      )}

      {(!config || showForm) && (
        <form
          onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
          className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-4"
        >
          <p className="text-xs text-gray-500">
            From a REST app in your PayPal developer dashboard. The app must have Payouts enabled —
            Test connection checks that, not just the password.
          </p>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Client ID</span>
            <input
              required value={clientId} onChange={(e) => setClientId(e.target.value)}
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
            />
          </label>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Client secret</span>
            <input
              required type="password" value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={config ? 'Type the secret again to save' : ''}
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
            />
          </label>

          <label className="block">
            <span className="text-gray-400 text-xs uppercase">Webhook ID</span>
            <input
              value={webhookId} onChange={(e) => setWebhookId(e.target.value)}
              placeholder="Optional — register the webhook first, then paste its ID"
              className="mt-1 w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
            />
          </label>

          <div className="space-y-1.5">
            <span className="text-gray-400 text-xs uppercase">Environment</span>
            <div className="flex gap-2">
              {(['sandbox', 'live'] as const).map((env) => (
                <button
                  key={env} type="button" onClick={() => setEnvironment(env)}
                  className={`px-3 py-1.5 rounded text-sm capitalize transition ${
                    environment === env ? 'bg-brand-600 text-white' : 'bg-surface-100 text-gray-300 hover:bg-surface-200'
                  }`}
                >
                  {env}
                </button>
              ))}
            </div>
            {environment === 'live' && (
              <p className="text-xs text-amber-300">
                Payouts sent with these credentials move real money out of your PayPal account.
              </p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={save.isPending || !clientId || !clientSecret}
              className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm font-medium"
            >
              Save
            </button>
            {showForm && (
              <button type="button" onClick={() => setShowForm(false)}
                className="text-gray-400 hover:text-white text-sm px-3 py-2">Cancel</button>
            )}
          </div>

          {save.isError && (
            <p className="text-red-400 text-sm">
              {save.error instanceof ApiError ? save.error.message : 'Save failed'}
            </p>
          )}
        </form>
      )}
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
