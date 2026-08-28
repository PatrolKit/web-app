import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { CheckinShell, ErrorNote, inputClass, primaryButtonClass, secondaryButtonClass } from './shared';
import type { CheckinContext } from '../../lib/api.types';

type Mode = 'contact' | 'code' | 'sent';

function channelTabClass(active: boolean): string {
  return [
    'py-2.5 rounded-md text-base font-medium transition-colors',
    active ? 'bg-brand-600 text-white' : 'text-gray-400 hover:text-gray-200',
  ].join(' ');
}

/**
 * Proving who you are, phone first.
 *
 * Phone leads because an SMS code offers itself in the iOS keyboard bar as it
 * arrives — one tap, no app switch. Email gets a link instead, which is the
 * shape email is good at, and the link carries the station on the challenge
 * record so it can open in a fresh tab and still know where you are standing.
 */
export default function SignInStep({ context }: { context: CheckinContext }) {
  const { login } = useAuth();
  const [mode, setMode] = useState<Mode>('contact');
  const [useEmail, setUseEmail] = useState(false);

  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');

  const [challengeId, setChallengeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const contact = useEmail ? email.trim() : phone.trim();

  async function sendCode() {
    setBusy(true);
    setError('');
    try {
      // Contact only. Who this is gets settled by the lookup on the server, and
      // a name — if we turn out not to have one — is asked for after.
      const res = await api.checkin.register(context.swapId, context.stationId, {
        ...(useEmail ? { email: email.trim() } : { phone: phone.trim() }),
      });
      setChallengeId(res.challengeId);
      // Dev convenience: with delivery switched off the server hands the code
      // back so the flow can be walked without a phone.
      if (res.devCode) setCode(res.devCode);
      setMode(res.channel === 'phone' ? 'code' : 'sent');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send a code');
    } finally {
      setBusy(false);
    }
  }

  async function confirmCode() {
    setBusy(true);
    setError('');
    try {
      const { accessToken } = await api.auth.confirmChallenge(challengeId, code.trim());
      if (!accessToken) throw new Error('That code did not sign you in');
      await login(accessToken);
      // The page re-renders with a session; CheckinPage takes it from here.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code did not work');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'sent') {
    return (
      <CheckinShell
        title="Check your email"
        subtitle={`We sent a sign-in link to ${email.trim()}.`}
        logoUrl={context.orgLogoUrl}
      >
        <p className="text-sm text-gray-400 text-center">
          Open the link on this phone and you will come straight back here.
        </p>
        <button className={secondaryButtonClass} onClick={() => setMode('contact')}>
          Use a different address
        </button>
      </CheckinShell>
    );
  }

  if (mode === 'code') {
    return (
      <CheckinShell
        title="Enter your code"
        subtitle={`We texted a 6-digit code to ${phone.trim()}.`}
        logoUrl={context.orgLogoUrl}
      >
        <input
          className={`${inputClass} text-center tracking-[0.4em] text-2xl`}
          // This is what makes the texted code one tap instead of six
          // keystrokes — iOS offers it in the keyboard bar as the SMS arrives.
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="000000"
          autoFocus
        />
        <ErrorNote>{error}</ErrorNote>
        <button className={primaryButtonClass} disabled={busy || code.length < 6} onClick={confirmCode}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
        <button className={secondaryButtonClass} disabled={busy} onClick={() => setMode('contact')}>
          Use a different number
        </button>
      </CheckinShell>
    );
  }

  return (
    <CheckinShell
      title={context.swapTitle}
      subtitle={`${context.orgName} · ${context.stationName}`}
      logoUrl={context.orgLogoUrl}
    >
      <div className="space-y-3">
        {/* Larger than the swap title above it, and deliberately so. The header
            is context — which swap, which counter — and a seller standing at a
            table needs the instruction to be the loudest thing on the screen. */}
        <h2 className="text-2xl font-bold text-center pb-1">Let&apos;s look you up</h2>

        {/* Phone sits on the left and starts selected: an SMS code offers itself
            in the iOS keyboard bar, which email cannot match. Both are one tap,
            so nothing is hidden behind a link. */}
        <div className="grid grid-cols-2 gap-2 p-1 bg-surface-100 rounded-lg">
          <button
            type="button"
            aria-pressed={!useEmail}
            className={channelTabClass(!useEmail)}
            onClick={() => { setUseEmail(false); setError(''); }}
          >
            Phone
          </button>
          <button
            type="button"
            aria-pressed={useEmail}
            className={channelTabClass(useEmail)}
            onClick={() => { setUseEmail(true); setError(''); }}
          >
            Email
          </button>
        </div>

        {useEmail ? (
          <input
            className={inputClass}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        ) : (
          <input
            className={inputClass}
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(555) 555-5555"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        )}

        <ErrorNote>{error}</ErrorNote>

        <button className={primaryButtonClass} disabled={busy || contact.length < 5} onClick={sendCode}>
          {busy ? 'Sending…' : useEmail ? 'Email me a link' : 'Text me a code'}
        </button>

        {!useEmail && (
          // Carriers require this disclosure to sit with the field that collects the
          // number: a screenshot of it is the evidence attached to the toll-free
          // registration, so this wording and the wording filed with AWS must match.
          <p className="text-xs text-gray-500 leading-relaxed">
            By tapping Text me a code you agree to receive a sign-in code and
            notifications about your consigned items from PatrolKit. Message frequency
            varies. Message and data rates may apply. Reply STOP to unsubscribe, HELP
            for help.
          </p>
        )}
      </div>

      <p className="text-xs text-gray-500 text-center">
        Already sold here before? Use the same number or address and we will find you.
      </p>
    </CheckinShell>
  );
}
