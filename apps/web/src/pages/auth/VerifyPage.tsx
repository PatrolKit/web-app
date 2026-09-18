import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faCircleCheck as faCircleCheckDuo,
  faShieldCheck as faShieldCheckDuo,
  faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { PoweredByFooter } from '../public/PoweredByFooter';

/**
 * Completes a sign-in link.
 *
 * Confirmation is behind a button, not a `useEffect`. Challenges are single-use,
 * and mail security scanners fetch every link they see — most do not run
 * JavaScript, which is the only reason firing on mount has not already been
 * spending people's codes for them. A tap is a signal a human is here.
 */
export default function VerifyPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A bare `verify` challenge proves a contact without minting a session.
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  // Challenge links carry the challenge id (c) alongside the token (t): an
  // email token and a 6-digit OTP share one table, so lookup is by id.
  const challengeId = searchParams.get('c');
  const token = searchParams.get('t');
  const malformed = !challengeId || !token;

  async function confirm() {
    if (malformed) return;
    setBusy(true);
    setError('');
    try {
      const { accessToken, context } = await api.auth.confirmChallenge(challengeId, token);
      if (!accessToken) { setVerifiedOnly(true); return; }
      await login(accessToken);

      // The context says what this sign-in was for. It is a pair of ids, never a
      // URL, so the destination is chosen here rather than by the server.
      if (context?.stationId && context?.swapId) {
        navigate(`/checkin?swap=${context.swapId}&station=${context.stationId}`, { replace: true });
        return;
      }
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  if (malformed || error) {
    return (
      <Shell icon={faTriangleExclamationDuo} tone="amber" title="That link did not work">
        {/* The server's sentence where there is one: an expired link and a
            link that was already used are different problems, and only it
            knows which. */}
        <p className="text-center text-sm text-gray-400">
          {error || 'This sign-in link is missing part of itself. Links can be broken by an email client that wraps them.'}
        </p>
        <a
          href="/auth/login"
          className="mt-6 block w-full rounded-lg bg-brand-600 hover:bg-brand-700 py-3 text-center text-white font-medium"
        >
          Back to sign in
        </a>
      </Shell>
    );
  }

  if (verifiedOnly) {
    return (
      <Shell icon={faCircleCheckDuo} tone="green" title="Contact verified">
        <p className="text-center text-sm text-gray-400">
          We have confirmed this address belongs to you. You can close this page.
        </p>
        <a
          href="/auth/login"
          className="mt-6 block w-full text-center text-sm text-gray-400 hover:text-white"
        >
          Sign in to PatrolKit
        </a>
      </Shell>
    );
  }

  return (
    <Shell icon={faShieldCheckDuo} tone="brand" title="Confirm it's you">
      <p className="text-center text-sm text-gray-400">
        Tap below to finish signing in.
      </p>

      {/* Lifted out of the sentence, the way the address is on "Check your
          email".

          "This link works once" said the true thing and left the consequence
          for the reader to work out — and the reader is somebody who may well
          come back to the same email tomorrow and tap it again. So it now says
          which link, and what to do when it has been spent. */}
      <p className="my-4 rounded-lg border border-gray-700 bg-surface-100 px-4 py-2.5 text-center text-sm text-gray-300">
        The link you followed works <span className="text-white font-medium">only once</span>.
        To sign in again later, request a new one.
      </p>

      <button
        onClick={confirm}
        disabled={busy}
        className="w-full py-3 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-medium rounded-lg"
      >
        {busy ? 'Signing you in…' : 'Sign in'}
      </button>
    </Shell>
  );
}

/**
 * The arrangement "Check your email" uses: a mark in a tinted disc, the heading
 * centred under it, the message below, and PatrolKit at the foot.
 *
 * Every state of this page wears it, including the failures — an error was a
 * line of red text on an otherwise empty screen, which reads like the app
 * broke rather than like the link did.
 */
function Shell({
  icon, tone, title, children,
}: {
  icon: IconDefinition;
  tone: 'brand' | 'green' | 'amber';
  title: string;
  children: React.ReactNode;
}) {
  const disc = {
    brand: 'bg-brand-600/15 text-brand-500',
    green: 'bg-green-500/15 text-green-400',
    amber: 'bg-amber-500/15 text-amber-400',
  }[tone];

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full">
        <div className="bg-surface-50 rounded-xl p-8">
          <div className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full ${disc}`}>
            <FontAwesomeIcon icon={icon} className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold text-white text-center mb-2">{title}</h1>
          {children}
        </div>
        <PoweredByFooter />
      </div>
    </div>
  );
}
