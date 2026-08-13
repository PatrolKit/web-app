import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';

export default function LoginPage() {
  const { user, isLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // If the silent refresh already restored a session, skip the login page
  if (!isLoading && user) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.auth.requestMagicLink(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center px-4">
        <div className="max-w-md w-full bg-surface-50 rounded-xl p-8 text-center">
          <h1 className="text-2xl font-bold text-white mb-4">Check your email</h1>
          <p className="text-gray-400">
            If <span className="text-white">{email}</span> has an account, a sign-in link is on its
            way. Check your inbox!
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-surface-50 rounded-xl p-8">
        <h1 className="text-3xl font-bold mb-2">
          <span className="text-brand-600">Patrol</span>Kit
        </h1>
        <p className="text-gray-400 mb-8">Sign in with your email</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
            className="w-full bg-surface-100 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-brand-600"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white rounded-lg px-4 py-3 font-semibold transition"
          >
            {loading ? 'Sending…' : 'Send sign-in link'}
          </button>
        </form>
      </div>
    </div>
  );
}
