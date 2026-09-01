import { useState } from 'react';
import './App.css';
import LoginGate from './LoginGate.jsx';
import AdsTracking from './AdsTracking.jsx';
import SpendSheet from './SpendSheet.jsx';
import Relaunch from './Relaunch.jsx';

function Logo() {
  return <img src="/logo.png" width="32" height="32" style={{ borderRadius: 8, display: 'block' }} alt="Scale Cases" />;
}

// Only the tabs in active use — Kill Analysis, Angle Matrix, State Variations,
// CPL Tracker and Lead Reports are hidden (components still exist in the repo)
const TABS = ['Ads Tracking', 'Spend Sheet', 'Relaunch'];

function logout() {
  localStorage.removeItem('sc_auth_token');
  window.location.reload();
}

// Lazy-mount: components mount on first visit and stay mounted (preserves state + ongoing work)
export default function App() {
  // Reopen on whatever tab was last active (falls back to Ads Tracking)
  const initialTab = (() => {
    const saved = localStorage.getItem('activeTab');
    return TABS.includes(saved) ? saved : 'Ads Tracking';
  })();
  const [tab, setTab] = useState(initialTab);
  const [mounted, setMounted] = useState(new Set([initialTab]));

  function switchTab(t) {
    setMounted(m => new Set([...m, t]));
    setTab(t);
    localStorage.setItem('activeTab', t);
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
        {/* Server-to-server integration indicator — makes the auth model explicit for Meta reviewers */}
        <span
          title="Meta Marketing API · ads_read · authenticated via System User Token stored encrypted server-side. No end-user Facebook Login is used."
          style={{
            marginLeft: 16, fontSize: 11, padding: '4px 10px',
            background: 'rgba(34,197,94,0.08)', border: '1px solid #16a34a',
            borderRadius: 6, color: '#15803d', whiteSpace: 'nowrap', fontWeight: 600,
          }}
        >
          ● Meta API · ads_read · system user token (S2S)
        </span>
        <button
          onClick={logout}
          style={{ marginLeft: 8, fontSize: 12, padding: '5px 12px', background: 'none', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          Log out
        </button>
      </header>
      <main className="content" style={{ padding: 0, boxSizing: 'border-box', minWidth: 0, overflow: 'clip' }}>
        {mounted.has('Ads Tracking') && <div style={show('Ads Tracking')}><AdsTracking /></div>}
        {mounted.has('Spend Sheet')  && <div style={show('Spend Sheet')}><SpendSheet /></div>}
        {mounted.has('Relaunch')     && <div style={show('Relaunch')}><Relaunch /></div>}
      </main>
      <footer style={{ textAlign: 'center', padding: '12px 0', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        <a href="/privacy-policy.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'underline' }}>
          Privacy Policy
        </a>
        <span style={{ margin: '0 8px', opacity: 0.5 }}>·</span>
        <a href="/terms.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'underline' }}>
          Terms of Use
        </a>
      </footer>
    </div>
    </LoginGate>
  );
}
