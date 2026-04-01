import { useState, useEffect } from 'react';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const TOKEN_KEY = 'sc_auth_token';

export default function LoginGate({ children }) {
  const [status, setStatus]   = useState('checking'); // checking | login | ok
  const [password, setPassword] = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem(TOKEN_KEY);
    fetch(`${BASE}/api/auth/verify`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.json())
      .then(d => setStatus(d.ok ? 'ok' : 'login'))
      .catch(() => setStatus('login'));
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const res  = await fetch(`${BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Incorrect password'); return; }
      localStorage.setItem(TOKEN_KEY, data.token);
      setStatus('ok');
    } catch {
      setError('Could not reach server. Try again.');
    } finally {
      setLoading(false);
    }
  }

  if (status === 'checking') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: 'var(--bg)' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading…</div>
      </div>
    );
  }

  if (status === 'login') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: 'var(--bg)' }}>
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 360, boxShadow: '0 4px 24px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
            <img src="/logo.png" width="36" height="36" style={{ borderRadius: 8 }} alt="" />
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Scale Cases</span>
          </div>
          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoFocus
                placeholder="Enter password"
                style={{
                  width: '100%', padding: '10px 12px', fontSize: 15, borderRadius: 8,
                  border: `1px solid ${error ? '#dc2626' : 'var(--border)'}`,
                  background: 'var(--bg)', color: 'var(--text)', outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {error && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{error}</div>}
            </div>
            <button
              type="submit"
              disabled={loading || !password}
              style={{
                padding: '10px', fontSize: 14, fontWeight: 600, borderRadius: 8,
                background: '#2563eb', color: '#fff', border: 'none', cursor: loading || !password ? 'not-allowed' : 'pointer',
                opacity: loading || !password ? 0.6 : 1,
              }}
            >
              {loading ? 'Checking…' : 'Sign In'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return children;
}
