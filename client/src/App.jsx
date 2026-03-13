import { useState } from 'react';
import './App.css';
import AdsTracking from './AdsTracking.jsx';
import SpendSheet from './SpendSheet.jsx';

function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="14" fill="#3a8f5c" />
      <path d="M50 14 L50 86" stroke="white" strokeWidth="8" strokeLinecap="round" />
      <path d="M50 14 L28 36 M50 14 L72 36" stroke="white" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M50 50 L22 68 M50 50 L78 68" stroke="white" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const TABS = ['Ads Tracking', 'Spend Sheet'];

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
      <main className="main">
        {tab === 'Ads Tracking' && <AdsTracking />}
        {tab === 'Spend Sheet'  && <SpendSheet />}
      </main>
    </div>
  );
}
