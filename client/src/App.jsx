import { useState, useEffect } from 'react';
import './App.css';
import LoginGate from './LoginGate.jsx';
import AdsTracking from './AdsTracking.jsx';
import SpendSheet from './SpendSheet.jsx';
import CampaignReports from './CampaignReports.jsx';
import StateVariations from './StateVariations.jsx';

function Logo() {
  return <img src="/logo.png" width="32" height="32" style={{ borderRadius: 8, display: 'block' }} alt="Scale Cases" />;
}

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const TABS = ['Ads Tracking', 'Spend Sheet', 'Campaign Reports', 'State Variations'];

function logout() {
  localStorage.removeItem('sc_auth_token');
  window.location.reload();
}

function useFbConnection() {
  const [connected, setConnected] = useState(() => localStorage.getItem('fb_connected') === '1');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('fb_connected') === '1') {
      localStorage.setItem('fb_connected', '1');
      setConnected(true);
      // Clean the query param from the URL without reloading
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (params.get('fb_error') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  return connected;
}

// Lazy-mount: components mount on first visit and stay mounted (preserves state + ongoing work)
export default function App() {
  const [tab, setTab] = useState('Ads Tracking');
  const [mounted, setMounted] = useState(new Set(['Ads Tracking']));
  const fbConnected = useFbConnection();

  function switchTab(t) {
    setMounted(m => new Set([...m, t]));
    setTab(t);
  }

  const show = t => ({ display: tab === t ? 'block' : 'none' });

  return (
    <LoginGate>
    <div className="app">
      <header className="header">
        <div className="header-brand"><Logo /> Scale Cases</div>
        <nav className="nav">
          {TABS.map(t => (
            <button key={t} className={`nav-tab${tab === t ? ' nav-tab--active' : ''}`} onClick={() => switchTab(t)}>{t}</button>
          ))}
        </nav>
        {fbConnected ? (
          <span style={{ marginLeft: 16, fontSize: 12, padding: '5px 12px', background: 'none', border: '1px solid #16a34a', borderRadius: 6, color: '#16a34a', whiteSpace: 'nowrap' }}>
            Facebook Connected
          </span>
        ) : (
          <a
            href={`${BASE}/api/auth/facebook`}
            style={{ marginLeft: 16, fontSize: 12, padding: '5px 12px', background: '#1877f2', border: 'none', borderRadius: 6, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap', textDecoration: 'none', display: 'inline-block' }}
          >
            Connect with Facebook
          </a>
        )}
        <button
          onClick={logout}
          style={{ marginLeft: 8, fontSize: 12, padding: '5px 12px', background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Log out
        </button>
      </header>
      <main className="content" style={{ padding: 0, boxSizing: 'border-box', minWidth: 0, overflow: 'clip' }}>
        {mounted.has('Ads Tracking')     && <div style={show('Ads Tracking')}><AdsTracking /></div>}
        {mounted.has('Spend Sheet')      && <div style={show('Spend Sheet')}><SpendSheet /></div>}
        {mounted.has('Campaign Reports') && <div style={show('Campaign Reports')}><CampaignReports /></div>}
        {mounted.has('State Variations') && <div style={show('State Variations')}><StateVariations /></div>}
      </main>
      <footer style={{ textAlign: 'center', padding: '12px 0', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        <a href="/privacy-policy.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'underline' }}>
          Privacy Policy
        </a>
      </footer>
    </div>
    </LoginGate>
  );
}
