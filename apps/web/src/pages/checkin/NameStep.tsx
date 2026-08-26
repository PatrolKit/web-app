import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { CheckinShell, ErrorNote, inputClass, primaryButtonClass } from './shared';
import type { CheckinContext } from '../../lib/api.types';

/**
 * Asks for a name, once, and only when there isn't one.
 *
 * Most sellers are already on the roster and never see this — the lookup on
 * their phone or email found them, name included. It exists for the person
 * selling here for the first time, whose receipt would otherwise be headed with
 * their own phone number.
 */
export default function NameStep({
  context,
  onDone,
}: {
  context: CheckinContext;
  onDone: () => void;
}) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.skiSwap.sellerUpdateProfile(context.orgId, {
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your name');
      setBusy(false);
    }
  }

  return (
    <CheckinShell
      title="What should we call you?"
      subtitle="This goes on your receipt and your item tags."
      logoUrl={context.orgLogoUrl}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <input
            className={inputClass}
            placeholder="First name"
            autoComplete="given-name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoFocus
          />
          <input
            className={inputClass}
            placeholder="Last name"
            autoComplete="family-name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>

        <ErrorNote>{error}</ErrorNote>

        <button className={primaryButtonClass} disabled={busy || !firstName.trim()} onClick={save}>
          {busy ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </CheckinShell>
  );
}
