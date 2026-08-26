import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

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
      <div className="min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error || 'Missing or malformed sign-in link'}</p>
          <a href="/auth/login" className="text-brand-600 hover:underline">Back to sign in</a>
        </div>
      </div>
    );
  }

  if (verifiedOnly) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="max-w-md text-center">
          <div className="text-5xl mb-4">✅</div>
          <h1 className="text-2xl font-bold text-white mb-2">Contact verified</h1>
          <p className="text-gray-400 mb-6">
            Thanks — we've confirmed this address belongs to you. You can close this page.
          </p>
          <a href="/auth/login" className="text-brand-600 hover:underline">Sign in to PatrolKit</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="max-w-sm w-full text-center space-y-6">
        <h1 className="text-2xl font-bold text-white">Confirm it's you</h1>
        <p className="text-gray-400">
          Tap below to finish signing in. This link works once.
        </p>
        <button
          onClick={confirm}
          disabled={busy}
          className="w-full py-3 bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white font-medium rounded-lg"
        >
          {busy ? 'Signing you in…' : 'Sign in'}
        </button>
      </div>
    </div>
  );
}
