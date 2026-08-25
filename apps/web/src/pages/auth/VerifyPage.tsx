import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

export default function VerifyPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { login } = useAuth();
  const [error, setError] = useState('');
  // A bare `verify` challenge proves a contact without minting a session.
  const [verifiedOnly, setVerifiedOnly] = useState(false);

  useEffect(() => {
    // Challenge links carry the challenge id (c) alongside the token (t): an
    // email token and a 6-digit OTP share one table, so lookup is by id.
    const challengeId = searchParams.get('c');
    const token = searchParams.get('t');
    if (!challengeId || !token) { setError('Missing or malformed sign-in link'); return; }

    api.auth.confirmChallenge(challengeId, token)
      .then(async ({ accessToken }) => {
        if (!accessToken) { setVerifiedOnly(true); return; }
        await login(accessToken);
        navigate('/dashboard', { replace: true });
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'Sign-in failed');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error}</p>
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
    <div className="min-h-screen bg-surface flex items-center justify-center">
      <p className="text-gray-400 animate-pulse">Signing you in…</p>
    </div>
  );
}
