import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';

export default function VerifySellerPage() {
  const [params] = useSearchParams();
  const sellerId = params.get('sellerId') ?? '';
  const token = params.get('token') ?? '';

  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!sellerId || !token) {
      setStatus('error');
      setMessage('Invalid verification link — missing parameters.');
      return;
    }
    api.public
      .confirmEmailVerification(sellerId, token)
      .then(() => {
        setStatus('success');
        setMessage('Your email has been verified.');
      })
      .catch((err: Error) => {
        setStatus('error');
        setMessage(err.message ?? 'Verification failed. The link may have expired or already been used.');
      });
  }, [sellerId, token]);

  return (
    <div style={{ fontFamily: "Inter, 'Plus Jakarta Sans', sans-serif", background: '#1a1a1a', color: '#fff', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 20px' }}>
      <div style={{ maxWidth: 480, background: '#252525', borderRadius: 8, padding: 40, textAlign: 'center' }}>
        <h1 style={{ color: '#dc2626', fontSize: 24, margin: '0 0 24px' }}>PatrolKit</h1>
        {status === 'pending' && (
          <p style={{ color: '#9ca3af' }}>Verifying your email…</p>
        )}
        {status === 'success' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
            <p style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>Email verified!</p>
            <p style={{ color: '#9ca3af', fontSize: 14 }}>{message}</p>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={{ fontSize: 48, marginBottom: 16 }}>❌</div>
            <p style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>Verification failed</p>
            <p style={{ color: '#9ca3af', fontSize: 14 }}>{message}</p>
          </>
        )}
      </div>
    </div>
  );
}
