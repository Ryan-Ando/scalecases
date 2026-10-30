import { useState, useEffect, memo } from 'react';
import './App.css';
import { initialSync, useSyncStatus } from './sync.js';
import AdsTracking from './AdsTracking.jsx';
import SpendSheet from './SpendSheet.jsx';
import Relaunch from './Relaunch.jsx';
import Disclaimers from './Disclaimers.jsx';

// The tabs take no props; memo keeps a tab switch or a sync-badge update from re-rendering every
// mounted tab (the Ads Tracking grid alone is ~19k cells)
const AdsTrackingTab = memo(AdsTracking);
const SpendSheetTab  = memo(SpendSheet);
const RelaunchTab    = memo(Relaunch);
const DisclaimersTab = memo(Disclaimers);

function Logo() {
  return <img src="/logo.png" width="32" height="32" style={{ borderRadius: 8, display: 'block' }} alt="Scale Cases" />;
}

// Only the tabs in active use — Kill Analysis, Angle Matrix, State Variations,
// CPL Tracker and Lead Reports are hidden (components still exist in the repo)
const TABS = ['Ads Tracking', 'Spend Sheet', 'Relaunch', 'Disclaimers'];

// The active tab lives in the URL hash (#spend-sheet) so each browser tab keeps its own
// page across refreshes; localStorage only supplies a default for a fresh window.
const slugOf = t => t.toLowerCase().replace(/\s+/g, '-');
const tabFromHash = () => TABS.find(t => slugOf(t) === window.location.hash.replace(/^#/, '')) || null;

// Lazy-mount: components mount on first visit and stay mounted (preserves state + ongoing work)
export default function App() {
  const initialTab = (() => {
    const saved = localStorage.getItem('activeTab');
    return tabFromHash() || (TABS.includes(saved) ? saved : 'Ads Tracking');
  })();
  const [tab, setTab] = useState(initialTab);
  const [mounted, setMounted] = useState(new Set([initialTab]));
  // Pull shared state from the server before any tab mounts (tabs read local storage at mount)
  const [ready, setReady] = useState(false);
  const sync = useSyncStatus();
  useEffect(() => { let live = true; initialSync().finally(() => { if (live) setReady(true); }); return () => { live = false; }; }, []);

  function switchTab(t, pushHistory = true) {
    setMounted(m => new Set([...m, t]));
    setTab(t);
    localStorage.setItem('activeTab', t);
    if (pushHistory && window.location.hash !== `#${slugOf(t)}`) window.history.pushState(null, '', `#${slugOf(t)}`);
  }
  // Make sure the URL carries the tab from the first paint, and follow back/forward navigation
  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, '', `#${slugOf(initialTab)}`);
    const onHash = () => { const t = tabFromHash(); if (t) switchTab(t, false); };
    window.addEventListener('popstate', onHash);
    return () => window.removeEventListener('popstate', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        {/* Server-to-server integration indicator — makes the auth model explicit for Meta reviewers */}
        <span
          className={`sync-badge sync-badge--${sync.state}`}
          title={sync.error || (sync.lastSync ? `Shared data last synced ${new Date(sync.lastSync).toLocaleTimeString()}` : 'Shared data sync')}
          onClick={() => { if (sync.updates) window.location.reload(); }}
          style={{ cursor: sync.updates ? 'pointer' : 'default' }}
        >
          {sync.updates ? '↻ New data from another device · click to reload'
            : sync.state === 'syncing' ? '● Syncing shared data…'
            : sync.state === 'offline' ? '● Sync offline (changes kept locally)'
            : sync.pending ? `● Saving ${sync.pending} change${sync.pending === 1 ? '' : 's'}…`
            : sync.persistent ? '● Shared across devices' : '● Shared (server disk not persistent!)'}
        </span>
        <span
          title="Meta Marketing API · ads_read · authenticated via System User Token stored encrypted server-side. No end-user Facebook Login is used."
          style={{
            marginLeft: 16, fontSize: 11, padding: '4px 10px',
            background: 'rgba(34,197,94,0.08)', border: '1px solid #16a34a',
            borderRadius: 6, color: '#82d9a2', whiteSpace: 'nowrap', fontWeight: 600,
          }}
        >
          ● Meta API · ads_read · system user token (S2S)
        </span>
      </header>
      <main className="content" style={{ padding: 0, boxSizing: 'border-box', minWidth: 0, overflow: 'clip' }}>
        {!ready && <div className="empty" style={{ padding: 60 }}><div className="empty-title">Syncing shared data…</div><div className="empty-desc">Pulling budgets, layouts and ad data from the server.</div></div>}
        {ready && mounted.has('Ads Tracking') && <div style={show('Ads Tracking')}><AdsTrackingTab /></div>}
        {ready && mounted.has('Spend Sheet')  && <div style={show('Spend Sheet')}><SpendSheetTab /></div>}
        {ready && mounted.has('Relaunch')     && <div style={show('Relaunch')}><RelaunchTab /></div>}
        {ready && mounted.has('Disclaimers')  && <div style={show('Disclaimers')}><DisclaimersTab /></div>}
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
  );
}
