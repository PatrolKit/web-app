import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
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
// The same test App.tsx branches on. Evaluated once; a host does not change.
const onSellerSite = window.location.hostname.startsWith('skiswap.');

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

  /*
   * What this link was for, so the screen can say it before spending the code.
   *
   * The challenge decides what actually happens; this only decides the wording.
   * Without it everybody was greeted with "Sign in", including the people who
   * were confirming an address and would never get a session — they found out
   * after tapping, which is the wrong order to learn it in.
   *
   * Tampering with it changes a sentence. The outcome screen below reports what
   * the server actually did.
   */
  const confirmingContact = searchParams.get('p') === 'verify';

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
      setError(
        err instanceof ApiError
          ? err.message
          : confirmingContact ? 'Could not confirm your email' : 'Sign-in failed',
      );
    } finally {
      setBusy(false);
    }
  }

  if (malformed || error) {
    return (
      <Shell icon={faTriangleExclamationDuo} tone="amber" title="That link did not work">
        {/* The server's sentence where there is one: an expired link and a link
            already used are different problems, and only it knows which. */}
        <p className="text-center text-sm text-gray-400">
          {error ||
            (confirmingContact
              ? 'This confirmation link is missing part of itself. An email client that wraps long lines can break one.'
              : 'This sign-in link is missing part of itself. An email client that wraps long lines can break one.')}
        </p>

        {/* Here, not on the page before it. This is the screen where somebody
            has actually been stopped, and the explanation is the difference
            between "the app is broken" and "ask for another one".
            
            Who to ask differs. A sign-in link is one the reader asks for
            themselves; a confirmation was sent on their behalf by somebody at a
            counter, and pointing them at the login page would send them
            somewhere that cannot issue another. */}
        <p className="my-4 rounded-lg border border-gray-700 bg-surface-100 px-4 py-2.5 text-center text-sm text-gray-300">
          {confirmingContact ? (
            <>
              Confirmation links work <span className="text-white font-medium">once</span> and
              expire after 15 minutes. Ask whoever sent it to send another.
            </>
          ) : (
            <>
              Sign-in links work <span className="text-white font-medium">once</span> and expire
              after 15 minutes. Getting another takes a moment.
            </>
          )}
        </p>

        {/* Where a new link comes from depends on where this one was going.
            On the seller site there is no login page: the link is minted by
            the station's check-in screen, which the QR code opens. Pointing
            sellers at `/auth/login` here sent them to a route that does not
            exist on that host — a blank page, at the moment they were already
            stuck. */}
        {!confirmingContact && (onSellerSite ? (
          <>
            <p className="text-center text-sm text-gray-400">
              Scan the QR code at your check-in station again to get a new one.
            </p>
            <Link
              to="/checkin"
              className="mt-4 block w-full rounded-lg bg-brand-600 hover:bg-brand-700 py-3 text-center text-white font-medium"
            >
              Back to check-in
            </Link>
          </>
        ) : (
          <Link
            to="/auth/login"
            className="block w-full rounded-lg bg-brand-600 hover:bg-brand-700 py-3 text-center text-white font-medium"
          >
            Send me a new link
          </Link>
        ))}
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
    <Shell
      icon={faShieldCheckDuo}
      tone="brand"
      title={confirmingContact ? 'Confirm your email address' : "Confirm it's you"}
    >
      <p className="text-center text-sm text-gray-400">
        {confirmingContact
          ? 'Tap below to confirm this address belongs to you. It will not sign you in.'
          : 'Tap below to finish signing in.'}
      </p>

      {/* Nothing here about links expiring or working once.
          
          Somebody on this page is signing in *now*, and most of them are
          holding a link that works — this screen cannot know yet, which is why
          the confirmation is behind a button at all. A caveat about needing a
          new link later is noise at best, and at worst reads as a warning that
          this one has already failed. It belongs on the screen where it has
          actually happened. */}
      <div className="mt-6">
      <button
        onClick={confirm}
        disabled={busy}
        className="w-full py-3 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-medium rounded-lg"
      >
        {confirmingContact
          ? (busy ? 'Confirming…' : 'Confirm my email')
          : (busy ? 'Signing you in…' : 'Sign in')}
      </button>
      </div>
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
