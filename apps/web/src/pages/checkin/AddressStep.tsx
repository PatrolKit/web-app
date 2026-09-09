import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { isZipComplete, resolveState, typeState, typeZip } from '../../lib/address';
import { CheckinShell, contextLine, ErrorNote, inputClass, primaryButtonClass } from './shared';
import type { CheckinContext, CheckinProfile } from '../../lib/api.types';

/**
 * Where the seller lives, asked of everyone whatever they choose next.
 *
 * Not a payout detail that happens to be needed for checks: it is how a person
 * is reached about their own property — an unsold item to collect, a query about
 * a tag — so a swap that only knows where its check-takers live has a gap in
 * it. The subtitle says as much, because a seller about to pick Venmo will
 * otherwise wonder what a swap wants with their address.
 *
 * State and ZIP correct themselves as they are typed rather than being marked
 * wrong afterwards. Somebody is standing at a counter with a line behind them,
 * and a field that quietly cannot hold a bad answer costs them nothing, where a
 * red message under it costs them a read and a second attempt.
 */
export default function AddressStep({
  context,
  profile,
  onDone,
}: {
  context: CheckinContext;
  profile: CheckinProfile;
  onDone: (address: { street: string; city: string; state: string; zip: string }) => void;
}) {
  const [street, setStreet] = useState(profile.street ?? '');
  const [city, setCity] = useState(profile.city ?? '');
  // A stored value can predate this form — "Vermont" from an import, say — so it
  // goes through the same coercion rather than being trusted for being saved.
  const [state, setState] = useState(typeState(profile.state ?? ''));
  const [zip, setZip] = useState(typeZip(profile.zip ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /**
   * Which fields the seller has finished with.
   *
   * Nothing is called wrong while it is being typed: "V" is not a bad state, it
   * is half of one, and a form that says so on the first keystroke reads as
   * hostile. A field only gets to complain once its owner has moved on.
   */
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const leave = (field: string) => setTouched((t) => ({ ...t, [field]: true }));

  // Resolved rather than compared: "VERMONT" is a valid answer that is not yet
  // in the form it will be stored in.
  const stateCode = resolveState(state);
  const zipDone = isZipComplete(zip);

  const complete = !!street.trim() && !!city.trim() && !!stateCode && zipDone;

  const stateProblem = touched.state && state.trim() && !stateCode
    ? `${state.trim()} is not a state we can mail to.`
    : '';
  const zipProblem = touched.zip && zip && !zipDone ? 'A ZIP code is five digits.' : '';

  async function save() {
    setBusy(true);
    setError('');
    const address = {
      street: street.trim(),
      city: city.trim(),
      // The code, never what was typed — the browser may have autofilled a full
      // name and never fired a blur to tidy it.
      state: stateCode,
      zip,
    };
    try {
      await api.skiSwap.updateSellerSelf(context.orgId, address);
      onDone(address);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that address');
    } finally {
      setBusy(false);
    }
  }

  return (
    <CheckinShell
      title="Where can we reach you?"
      subtitle={contextLine(context)}
      logoUrl={context.orgLogoUrl}
    >
      <div className="space-y-3">
        <p className="text-sm text-gray-400 text-center">
          For mailing a check, and for anything about your items after the swap.
        </p>

        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">Street</span>
          <input
            className={inputClass}
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            autoComplete="street-address"
            autoFocus
          />
        </label>

        {/* City takes the room, since a state and a ZIP are short and known. */}
        <div className="grid grid-cols-4 gap-2">
          <label className="block col-span-2">
            <span className="block text-xs text-gray-400 mb-1">City</span>
            <input
              className={inputClass}
              value={city}
              onChange={(e) => setCity(e.target.value)}
              autoComplete="address-level2"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">State</span>
            <input
              className={inputClass}
              value={state}
              onChange={(e) => setState(typeState(e.target.value))}
              // Snaps a resolved answer to its code on the way out, and leaves
              // an unresolved one alone so its owner can see what they typed.
              onBlur={() => { leave('state'); if (stateCode) setState(stateCode); }}
              autoComplete="address-level1"
              autoCapitalize="characters"
              maxLength={30}
              aria-invalid={!!stateProblem}
            />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">ZIP</span>
            <input
              className={inputClass}
              value={zip}
              onChange={(e) => setZip(typeZip(e.target.value))}
              onBlur={() => leave('zip')}
              autoComplete="postal-code"
              inputMode="numeric"
              aria-invalid={!!zipProblem}
            />
          </label>
        </div>

        {(stateProblem || zipProblem) && (
          <p className="text-xs text-amber-400">{stateProblem || zipProblem}</p>
        )}

        <ErrorNote>{error}</ErrorNote>

        <button className={primaryButtonClass} disabled={!complete || busy} onClick={save}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </CheckinShell>
  );
}
