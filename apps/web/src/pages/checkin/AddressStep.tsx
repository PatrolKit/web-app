import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { CheckinShell, contextLine, ErrorNote, inputClass, primaryButtonClass } from './shared';
import type { CheckinContext, CheckinProfile } from '../../lib/api.types';

/**
 * Where the seller lives, asked of everyone whatever they choose next.
 *
 * Not a payout detail that happens to be needed for cheques: it is how a person
 * is reached about their own property — an unsold item to collect, a query about
 * a tag — so a swap that only knows where its cheque-takers live has a gap in
 * it. The subtitle says as much, because a seller about to pick Venmo will
 * otherwise wonder what a swap wants with their address.
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
  const [state, setState] = useState(profile.state ?? '');
  const [zip, setZip] = useState(profile.zip ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const complete = !!street.trim() && !!city.trim() && !!state.trim() && !!zip.trim();

  async function save() {
    setBusy(true);
    setError('');
    const address = {
      street: street.trim(),
      city: city.trim(),
      state: state.trim(),
      zip: zip.trim(),
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
              onChange={(e) => setState(e.target.value)}
              autoComplete="address-level1"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">ZIP</span>
            <input
              className={inputClass}
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              autoComplete="postal-code"
              inputMode="numeric"
            />
          </label>
        </div>

        <ErrorNote>{error}</ErrorNote>

        <button className={primaryButtonClass} disabled={!complete || busy} onClick={save}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </CheckinShell>
  );
}
