import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { CheckinShell, contextLine, ErrorNote, primaryButtonClass, secondaryButtonClass } from './shared';
import type { CheckinContext, CheckinProfile } from '../../lib/api.types';

type Method = 'CHECK' | 'PAYPAL' | 'VENMO';

function segmentClass(active: boolean): string {
  return [
    'py-2.5 rounded-md text-base font-medium transition-colors',
    active ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
  ].join(' ');
}

/**
 * How the seller wants paying.
 *
 * Only to somewhere proven (Plan 35): PayPal pays the email they verified by
 * signing in, and nothing typed. Venmo is set only by scanning the seller's
 * Venmo code at the counter, on the staff iPad, so it appears here only when
 * one is already on file, to keep. Everyone can choose a check.
 */
export default function PayoutStep({
  context,
  profile,
  address,
  onDone,
  onEditAddress,
}: {
  context: CheckinContext;
  profile: CheckinProfile;
  /** From the previous step, shown back rather than asked for again. */
  address: { street: string; city: string; state: string; zip: string };
  onDone: () => void;
  /** Steps back to the address, so there is one address and one place to edit it. */
  onEditAddress: () => void;
}) {
  const hasVenmo = profile.payoutMethod === 'VENMO' && !!profile.payoutHandle;
  const methods: Method[] = [
    ...(profile.verifiedEmail ? (['PAYPAL'] as Method[]) : []),
    ...(hasVenmo ? (['VENMO'] as Method[]) : []),
    'CHECK',
  ];

  /**
   * Opens on what's on file when it's still allowed, else on PayPal when the
   * seller has a verified email, else on Check. Electronic payout leads, but
   * never into one they can't use.
   */
  const [method, setMethod] = useState<Method>(
    hasVenmo ? 'VENMO' : profile.verifiedEmail ? 'PAYPAL' : 'CHECK',
  );

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** What the money is actually going to, as the seller will read it back. */
  function destination(): string {
    if (method === 'CHECK') return `${address.street}, ${address.city} ${address.state} ${address.zip}`;
    if (method === 'VENMO') return profile.payoutHandle ?? '';
    return profile.verifiedEmail ?? '';
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      // A Venmo account on file is kept as it is: only the iPad can set one.
      if (method !== 'VENMO') {
        // A verified email carries no handle: the destination resolves from
        // the contact when the money moves, so a stored copy could go stale.
        const payout =
          method === 'CHECK'
            ? { payoutMethod: 'CHECK' as const, payoutTarget: null, payoutHandle: null }
            : { payoutMethod: 'PAYPAL' as const, payoutTarget: 'EMAIL' as const, payoutHandle: null };
        await api.skiSwap.updateSellerSelf(context.orgId, payout);
      }
      onDone();
    } catch (err) {
      setConfirming(false);
      setError(err instanceof ApiError ? err.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  const dest = destination();

  if (confirming) {
    return (
      <CheckinShell
        title="Is this right?"
        subtitle={contextLine(context)}
        logoUrl={context.orgLogoUrl}
      >
        <div className="space-y-4">
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-2 text-center">
            <p className="text-xs text-gray-400">Sending your money to</p>
            <p className="text-lg text-white font-medium break-words">{dest}</p>
            <p className="text-xs text-gray-500">
              {method === 'CHECK' ? 'By check' : method === 'VENMO' ? 'Venmo' : 'PayPal'}
            </p>
          </div>

          <ErrorNote>{error}</ErrorNote>

          <button className={primaryButtonClass} disabled={busy} onClick={save}>
            {busy ? 'Saving…' : "That's right"}
          </button>
          <button className={secondaryButtonClass} disabled={busy} onClick={() => setConfirming(false)}>
            Fix it
          </button>
        </div>
      </CheckinShell>
    );
  }

  return (
    <CheckinShell
      title="How should we pay you?"
      subtitle={contextLine(context)}
      logoUrl={context.orgLogoUrl}
    >
      <div className="space-y-3">
        <div
          className="grid gap-2 p-1 bg-surface-100 rounded-lg"
          style={{ gridTemplateColumns: `repeat(${methods.length}, minmax(0, 1fr))` }}
        >
          {/* PayPal first, Check last: the order is the nudge. */}
          {methods.map((m) => (
            <button key={m} className={segmentClass(method === m)} onClick={() => setMethod(m)}>
              {m === 'CHECK' ? 'Check' : m === 'PAYPAL' ? 'PayPal' : 'Venmo'}
            </button>
          ))}
        </div>

        {method === 'CHECK' && (
          // Asks for nothing: the address arrived a screen ago, and one place to
          // edit it means one answer.
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-1">
            <p className="text-xs text-gray-400">Mailing your check to</p>
            <p className="text-sm text-white">{address.street}</p>
            <p className="text-sm text-white">
              {address.city}, {address.state} {address.zip}
            </p>
            <button className="text-xs text-brand-500 hover:underline pt-1" onClick={onEditAddress}>
              Change
            </button>
          </div>
        )}

        {method === 'PAYPAL' && (
          // The same card the cheque address gets: it is the destination, and
          // the one thing on this screen worth reading twice.
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-1">
            <p className="text-xs text-gray-400">Sending your PayPal payment to</p>
            <p className="text-sm text-white break-all">{profile.verifiedEmail}</p>
            <p className="text-xs text-green-400">✓ Verified: this is the email you signed in with</p>
          </div>
        )}

        {method === 'VENMO' && (
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-1">
            <p className="text-xs text-gray-400">Sending your Venmo payment to</p>
            <p className="text-sm text-white break-all">{profile.payoutHandle}</p>
            <p className="text-xs text-gray-500">Set from your Venmo code at the counter. Staff there can change it.</p>
          </div>
        )}

        {!profile.verifiedEmail && (
          <p className="text-xs text-gray-500">
            PayPal pays a verified email. Sign in with your email to choose PayPal, or ask staff at the
            counter to scan your Venmo code.
          </p>
        )}

        <ErrorNote>{error}</ErrorNote>

        <button className={primaryButtonClass} onClick={() => setConfirming(true)}>
          Continue
        </button>
      </div>
    </CheckinShell>
  );
}
