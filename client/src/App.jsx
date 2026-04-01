import { useState } from 'react';
import './App.css';
import AdsTracking from './AdsTracking.jsx';
import SpendSheet from './SpendSheet.jsx';
import CampaignReports from './CampaignReports.jsx';
import AdsLauncher from './AdsLauncher.jsx';
import StateVariations from './StateVariations.jsx';

function Logo() {
  return <img src="/logo.png" width="32" height="32" style={{ borderRadius: 8, display: 'block' }} alt="Scale Cases" />;
}

const TABS = ['Ads Tracking', 'Spend Sheet', 'Campaign Reports', 'Ads Launcher', 'State Variations'];

// Lazy-mount: components mount on first visit and stay mounted (preserves state + ongoing work)
export default function App() {
  const [tab, setTab] = useState('Ads Tracking');
  const [mounted, setMounted] = useState(new Set(['Ads Tracking']));

  function switchTab(t) {
    setMounted(m => new Set([...m, t]));
    setTab(t);
  }

  const show = t => ({ display: tab === t ? 'block' : 'none' });

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand"><Logo /> Scale Cases</div>
        <nav className="nav">
          {TABS.map(t => (
            <button key={t} className={`nav-tab${tab === t ? ' nav-tab--active' : ''}`} onClick={() => switchTab(t)}>{t}</button>
          ))}
        </nav>
      </header>
      <main className="content" style={{ padding: 0, boxSizing: 'border-box', minWidth: 0, overflow: 'clip' }}>
        {mounted.has('Ads Tracking')     && <div style={show('Ads Tracking')}><AdsTracking /></div>}
        {mounted.has('Spend Sheet')      && <div style={show('Spend Sheet')}><SpendSheet /></div>}
        {mounted.has('Campaign Reports') && <div style={show('Campaign Reports')}><CampaignReports /></div>}
        {mounted.has('Ads Launcher')     && <div style={show('Ads Launcher')}><AdsLauncher /></div>}
        {mounted.has('State Variations') && <div style={show('State Variations')}><StateVariations /></div>}
      </main>
      <footer style={{ textAlign: 'center', padding: '12px 0', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        <a href="/privacy-policy.html" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--text-muted)', textDecoration: 'underline' }}>
          Privacy Policy
        </a>
      </footer>
    </div>
  );
}
