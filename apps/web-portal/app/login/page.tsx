'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, ApiError, session, SessionUser } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('agent@safaridesk.dev');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ accessToken: string; user: SessionUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      session.save(res.accessToken, res.user);
      router.replace('/search');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server. Is the API running?');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login stack" onSubmit={submit}>
        <div>
          <h1>
            Trip<span style={{ color: 'var(--brand)' }}>wise</span> partner portal
          </h1>
          <p className="muted small" style={{ margin: 0 }}>
            Sign in with your agency account.
          </p>
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
        </div>
        {error && <div className="alert bad">{error}</div>}
        <button className="btn" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small" style={{ margin: 0 }}>
          Local demo users are listed in the README (password Password123!).
        </p>
      </form>
    </div>
  );
}
