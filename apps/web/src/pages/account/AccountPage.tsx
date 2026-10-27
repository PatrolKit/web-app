import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { MyClockResponse } from '../../lib/api.types';

/**
 * The signed-in person's own page (Plan 57 D7). For now it holds how they clock
 * in at each org: the NSP ID their patrol set, or a 6-digit PIN they choose.
 */
export default function AccountPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['me/clock'], queryFn: () => api.me.clock() });

  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;
  if (error) return <p className="text-red-400 text-sm">{(error as Error).message}</p>;
  const orgs = (data?.orgs ?? []).filter((o) => o.timeTracking);

  return (
    <div className="space-y-6 max-w-lg">
      <h1 className="text-2xl font-bold text-white">My account</h1>
      <section className="space-y-4">
        <h2 className="text-white font-semibold">Clocking in</h2>
        {orgs.length === 0 ? (
          <p className="text-gray-500 text-sm">None of your patrols uses the time clock.</p>
        ) : (
          orgs.map((o) => <ClockIdentity key={o.orgId} org={o} showOrg={orgs.length > 1} />)
        )}
      </section>
    </div>
  );
}

function ClockIdentity({ org, showOrg }: { org: MyClockResponse['orgs'][number]; showOrg: boolean }) {
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => api.me.setClockPin(org.orgId, pin),
    onSuccess: (next) => {
      qc.setQueryData(['me/clock'], next);
      setPin('');
      setEditing(false);
      setSaved(true);
    },
  });

  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4 space-y-2">
      {showOrg && <p className="text-white font-medium">{org.orgName}</p>}
      {org.inactive && (
        <p className="text-amber-300 text-sm">You're inactive here, so you're off the iPads for now. Ask a patrol leader.</p>
      )}
      {org.nspId ? (
        <p className="text-gray-300 text-sm">
          You clock in with your NSP ID, <span className="text-white tabular-nums">{org.nspId}</span>. Your patrol keeps
          it up to date; ask a patrol leader if it's wrong.
        </p>
      ) : org.clockPinSet && !editing ? (
        <div className="space-y-2">
          <p className="text-gray-300 text-sm">
            {saved ? 'Saved. ' : ''}You clock in with the 6-digit PIN you chose.
          </p>
          <button onClick={() => { setEditing(true); setSaved(false); }} className="text-sm text-brand-500 hover:underline">
            Change my PIN
          </button>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="space-y-2">
          <p className="text-gray-300 text-sm">
            {org.clockPinSet
              ? 'Choose a new 6-digit PIN.'
              : "You don't have an NSP ID here, so choose a 6-digit PIN to clock in with on the patrol's iPads."}
          </p>
          <div className="flex gap-2">
            <label htmlFor={`pin-${org.orgId}`} className="sr-only">PIN</label>
            <input
              id={`pin-${org.orgId}`}
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="6 digits"
              className="w-32 bg-surface-100 border border-gray-700 rounded px-3 py-2 text-white text-sm tabular-nums tracking-widest"
            />
            <button type="submit" disabled={pin.length !== 6 || save.isPending}
              className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-2 rounded text-sm">
              {save.isPending ? 'Saving…' : 'Save PIN'}
            </button>
            {org.clockPinSet && (
              <button type="button" onClick={() => { setEditing(false); setPin(''); }} className="text-gray-400 hover:text-white text-sm px-2">
                Cancel
              </button>
            )}
          </div>
          {save.error && <p className="text-red-400 text-sm" role="alert">{(save.error as Error).message}</p>}
        </form>
      )}
    </div>
  );
}
