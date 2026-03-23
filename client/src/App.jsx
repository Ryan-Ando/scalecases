import { useState } from 'react';
import './App.css';
import AdsTracking from './AdsTracking.jsx';
import SpendSheet from './SpendSheet.jsx';
import CampaignReports from './CampaignReports.jsx';
import AdsLauncher from './AdsLauncher.jsx';

function Logo() {
  return <img src="/logo.png" width="32" height="32" style={{ borderRadius: 8, display: 'block' }} alt="Scale Cases" />;
}

const TABS = ['Ads Tracking', 'Spend Sheet', 'Campaign Reports', 'Ads Launcher'];

export default function App() {
  const [tab, setTab] = useState('Ads Tracking');

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand"><Logo /> Scale Cases</div>
        <nav className="nav">
          {TABS.map(t => (
            <button key={t} className={`nav-tab${tab === t ? ' nav-tab--active' : ''}`} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
      </header>
      <main className="content" style={{ padding: 0, boxSizing: 'border-box', minWidth: 0, overflow: 'clip' }}>
        {tab === 'Ads Tracking'    && <AdsTracking />}
        {tab === 'Spend Sheet'     && <SpendSheet />}
        {tab === 'Campaign Reports' && <CampaignReports />}
        {tab === 'Ads Launcher'    && <AdsLauncher />}
      </main>
    </div>
  );
}
