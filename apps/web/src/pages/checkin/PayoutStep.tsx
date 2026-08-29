import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { CheckinShell, contextLine, ErrorNote, inputClass, primaryButtonClass, secondaryButtonClass } from './shared';
import type { CheckinContext, CheckinProfile } from '../../lib/api.types';

type Method = 'CHECK' | 'PAYPAL' | 'VENMO';
type Target = 'PAYPAL_ID' | 'EMAIL' | 'PHONE' | 'VENMO_ID';

function segmentClass(active: boolean): string {
  return [
    'py-2.5 rounded-md text-base font-medium transition-colors',
    active ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
  ].join(' ');
}

/**
 * How the seller wants paying.
 *
 * Two segmented controls, nested: the method, and — for PayPal alone — which of
 * PayPal Payouts' three recipient types to use. The nesting follows the domain
 * rather than the layout, which is why Venmo is a bare field and not a control
 * with one option in it.
 *
 * A verified segment states its value and asks for nothing, so the only input
 * on the screen is a typed ID. That is also the only answer nothing downstream
 * can check, which is what the confirmation before Continue is for.
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
  const [method, setMethod] = useState<Method>(
    profile.payoutMethod === 'PAYPAL' || profile.payoutMethod === 'VENMO'
      ? profile.payoutMethod
      : 'CHECK',
  );

  // Opens on a verified segment when there is one, so the default path is the
  // one that cannot be mistyped. PayPal ID stays first in the order.
  const [target, setTarget] = useState<Target>(() => {
    if (profile.payoutTarget && profile.payoutTarget !== 'VENMO_ID') return profile.payoutTarget;
    if (profile.verifiedEmail) return 'EMAIL';
    if (profile.verifiedPhone) return 'PHONE';
    return 'PAYPAL_ID';
  });

  const [handle, setHandle] = useState(
    profile.payoutHandle ?? profile.verifiedEmail ?? profile.verifiedPhone ?? '',
  );
  const [venmoId, setVenmoId] = useState(
    profile.payoutTarget === 'VENMO_ID' ? (profile.payoutHandle ?? '') : '',
  );

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const paypalTargets: Target[] = [
    'PAYPAL_ID',
    ...(profile.verifiedEmail ? (['EMAIL'] as Target[]) : []),
    ...(profile.verifiedPhone ? (['PHONE'] as Target[]) : []),
  ];

  /** What the money is actually going to, as the seller will read it back. */
  function destination(): { text: string; verified: boolean } {
    if (method === 'CHECK') {
      return { text: `${address.street}, ${address.city} ${address.state} ${address.zip}`, verified: true };
    }
    if (method === 'VENMO') return { text: venmoId.trim(), verified: false };
    if (target === 'EMAIL') return { text: profile.verifiedEmail ?? '', verified: true };
    if (target === 'PHONE') return { text: profile.verifiedPhone ?? '', verified: true };
    return { text: handle.trim(), verified: false };
  }

  const ready =
    method === 'CHECK' ||
    (method === 'VENMO' && !!venmoId.trim()) ||
    (method === 'PAYPAL' && (target !== 'PAYPAL_ID' || !!handle.trim()));

  async function save() {
    setBusy(true);
    setError('');
    try {
      // A verified target carries no handle: the destination resolves from the
      // contact when the money moves, so a stored copy could go stale.
      const payout =
        method === 'CHECK'
          ? { payoutMethod: 'CHECK' as const, payoutTarget: null, payoutHandle: null }
          : method === 'VENMO'
            ? { payoutMethod: 'VENMO' as const, payoutTarget: 'VENMO_ID' as const, payoutHandle: venmoId.trim() }
            : target === 'PAYPAL_ID'
              ? { payoutMethod: 'PAYPAL' as const, payoutTarget: 'PAYPAL_ID' as const, payoutHandle: handle.trim() }
              : { payoutMethod: 'PAYPAL' as const, payoutTarget: target, payoutHandle: null };

      await api.skiSwap.updateSellerSelf(context.orgId, payout);
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
            <p className="text-lg text-white font-medium break-words">{dest.text}</p>
            <p className="text-xs text-gray-500">
              {method === 'CHECK' ? 'By cheque' : method === 'VENMO' ? 'Venmo' : 'PayPal'}
            </p>
          </div>

          {/* The one answer nothing downstream can check says so; the rest
              simply state themselves. */}
          {!dest.verified && (
            <p className="text-sm text-amber-400 text-center">
              We cannot check this with {method === 'VENMO' ? 'Venmo' : 'PayPal'}, so please make
              sure it is right.
            </p>
          )}

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
        <div className="grid grid-cols-3 gap-2 p-1 bg-surface-100 rounded-lg">
          {(['CHECK', 'PAYPAL', 'VENMO'] as Method[]).map((m) => (
            <button key={m} className={segmentClass(method === m)} onClick={() => setMethod(m)}>
              {m === 'CHECK' ? 'Check' : m === 'PAYPAL' ? 'PayPal' : 'Venmo'}
            </button>
          ))}
        </div>

        {method === 'CHECK' && (
          // Asks for nothing: the address arrived a screen ago, and one place to
          // edit it means one answer.
          <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-1">
            <p className="text-xs text-gray-400">Posting your cheque to</p>
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
          <>
            <div
              className="grid gap-2 p-1 bg-surface-100 rounded-lg"
              style={{ gridTemplateColumns: `repeat(${paypalTargets.length}, minmax(0, 1fr))` }}
            >
              {paypalTargets.map((t) => (
                <button key={t} className={segmentClass(target === t)} onClick={() => setTarget(t)}>
                  {t === 'PAYPAL_ID' ? 'PayPal ID' : t === 'EMAIL' ? 'Email' : 'Phone'}
                </button>
              ))}
            </div>

            {target === 'PAYPAL_ID' ? (
              <label className="block">
                <input
                  className={inputClass}
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  placeholder="you@example.com"
                />
                <span className="block text-xs text-gray-500 mt-1">
                  Whatever your PayPal account is under.
                </span>
              </label>
            ) : (
              <p className="text-sm text-gray-400 text-center">
                Sending to{' '}
                <span className="text-white">
                  {target === 'EMAIL' ? profile.verifiedEmail : profile.verifiedPhone}
                </span>
                <span className="text-green-400"> ✓ verified</span>
              </p>
            )}
          </>
        )}

        {method === 'VENMO' && (
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Your Venmo ID</span>
            <input
              className={inputClass}
              value={venmoId}
              onChange={(e) => setVenmoId(e.target.value)}
              placeholder="@your-venmo"
            />
          </label>
        )}

        <ErrorNote>{error}</ErrorNote>

        <button className={primaryButtonClass} disabled={!ready} onClick={() => setConfirming(true)}>
          Continue
        </button>
      </div>
    </CheckinShell>
  );
}
