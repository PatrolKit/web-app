import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faEnvelopeOpenText as faEnvelopeOpenTextDuo,
  faCommentSms as faCommentSmsDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { PoweredByFooter } from '../public/PoweredByFooter';
import { useAuth } from '../../contexts/AuthContext';

type Channel = 'email' | 'phone';

export default function LoginPage() {
  const { user, isLoading, login } = useAuth();
  // Phone leads: an SMS code offers itself in the iOS keyboard bar, which an
  // emailed link cannot match.
  const [channel, setChannel] = useState<Channel>('phone');
  const [contact, setContact] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // If the silent refresh already restored a session, skip the login page
  if (!isLoading && user) return <Navigate to="/dashboard" replace />;

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await api.auth.login(
        channel === 'email' ? { email: contact } : { phone: contact },
      );
      // challengeId is null when nobody matches — deliberately indistinguishable
      // from success, so the page says the same thing either way.
      setChallengeId(res.challengeId);
      setDevCode(res.devCode);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();
    if (!challengeId) return;
    setError('');
    setLoading(true);
    try {
      const { accessToken } = await api.auth.confirmChallenge(challengeId, code.trim());
      if (accessToken) await login(accessToken);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center px-4 py-10">
        <div className="max-w-md w-full">
          <div className="bg-surface-50 rounded-xl p-8">
            {/* Somewhere to look while the message arrives. This screen is a
                wait, and a wall of grey text does not read as progress. */}
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-brand-600/15">
              <FontAwesomeIcon
                icon={channel === 'email' ? faEnvelopeOpenTextDuo : faCommentSmsDuo}
                className="h-6 w-6 text-brand-500"
              />
            </div>

            <h1 className="text-2xl font-bold text-white text-center mb-2">
              {channel === 'email' ? 'Check your email' : 'Check your messages'}
            </h1>
            <p className="text-gray-400 text-center text-sm">
              {channel === 'email' ? 'A sign-in link is on its way to' : 'We sent a 6-digit code to'}
            </p>

            {/* Lifted out of the sentence. It is the one thing on this screen
                worth checking for a typo, and inline it read as prose. */}
            <p className="my-3 rounded-lg border border-gray-700 bg-surface-100 px-4 py-2.5 text-center text-white font-medium break-all">
              {contact}
            </p>

            <p className="text-gray-500 text-center text-xs mb-6">
              …if it has an account here.
            </p>

            {devCode && (
              <p className="mb-4 text-xs text-amber-400 bg-amber-950/40 rounded p-3">
                Notifications are switched off in this environment. Your code is{' '}
                {/* An email challenge's code is a 64-character token, which
                    ran off the edge of this box before it could be read. */}
                <span className="font-mono text-amber-200 break-all">{devCode}</span>
              </p>
            )}

            {channel === 'phone' && challengeId && (
              <form onSubmit={handleConfirm} className="space-y-4">
                <input
                  inputMode="numeric"
                  // Offers the texted code in the iOS keyboard bar as it arrives.
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  required
                  className="w-full bg-surface-100 border border-gray-700 rounded-lg px-4 py-3 text-white tracking-widest placeholder-gray-500 focus:outline-none focus:border-brand-600"
                />
                {error && <p className="text-red-400 text-sm">{error}</p>}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-3"
                >
                  {loading ? 'Verifying…' : 'Sign in'}
                </button>
              </form>
            )}

            <button
              onClick={() => { setSent(false); setCode(''); setError(''); }}
              className="mt-6 w-full text-center text-sm text-gray-400 hover:text-white"
            >
              Use a different {channel === 'email' ? 'email' : 'number'}
            </button>
          </div>
          <PoweredByFooter />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4 py-10">
      <div className="max-w-md w-full bg-surface-50 rounded-xl p-8">
        {/* The mark, then the name. This is the front door of the product and
            it wore a text wordmark and nothing else, which is less branding
            than the footer of a public seller page.

            `logo-mark.png` rather than `logo.png`: the same artwork at 128px
            instead of 1254, which is 13 KB against 522 for something drawn
            here at 56. */}
        <div className="mb-7 text-center">
          <img
            src="/logo-mark.png"
            alt=""
            className="mx-auto mb-3 h-14 w-14"
          />
          <h1 className="text-3xl font-bold">
            <span className="text-brand-600">Patrol</span>Kit
          </h1>
          <p className="text-gray-400 text-sm mt-1.5">
            Sign in with your phone number or email
          </p>
        </div>

        <div className="flex gap-2 mb-6">
          {(['phone', 'email'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setChannel(c); setContact(''); setError(''); }}
              aria-pressed={channel === c}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-medium ${
                channel === c
                  ? 'bg-brand-600 text-white'
                  : 'bg-surface-100 text-gray-400 hover:text-white'
              }`}
            >
              {c === 'phone' ? 'Phone' : 'Email'}
            </button>
          ))}
        </div>

        <form onSubmit={handleRequest} className="space-y-4">
          <input
            type={channel === 'email' ? 'email' : 'tel'}
            inputMode={channel === 'email' ? 'email' : 'tel'}
            autoComplete={channel === 'email' ? 'email' : 'tel'}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            placeholder={channel === 'email' ? 'you@example.com' : '(555) 010-1001'}
            required
            className="w-full bg-surface-100 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-600"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white font-semibold rounded-lg px-4 py-3"
          >
            {loading ? 'Sending…' : channel === 'email' ? 'Send sign-in link' : 'Send code'}
          </button>

          {channel === 'phone' && (
            // Carriers require this disclosure to sit with the field that collects the
            // number: the screenshot of it is the evidence attached to the toll-free
            // registration, so the wording here and the wording filed with AWS must match.
            <p className="text-xs text-gray-500 leading-relaxed">
              By tapping Send code you agree to receive a sign-in code from PatrolKit.
              Message frequency varies. Message and data rates may apply. Reply STOP to
              unsubscribe, HELP for help, or contact{' '}
              <a href="mailto:support@patrolkit.io" className="underline hover:text-gray-300">
                support@patrolkit.io
              </a>
              .{' '}
              <a href="/terms.html" className="underline hover:text-gray-300">
                Terms of Service
              </a>{' '}
              &middot;{' '}
              <a href="/privacy.html" className="underline hover:text-gray-300">
                Privacy Policy
              </a>
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
