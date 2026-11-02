// "Launch any ad" on the Relaunch tab: any creative in the local library, into any brand + state
// AdManage has a copy template for, several states at once. Each state gets its own launcher
// (live campaign, copy template, state/default versions, review-before-write, one AdManage draft),
// the same one the state cards below use.
import { useEffect, useMemo, useRef, useState } from 'react';
import AdManageLaunch from './AdManageLaunch.jsx';
import { creativeKey } from './creativeMatching.js';
import { LAUNCH_EVENT, takeLaunchRequests } from './launchBus.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const money = n => `$${Math.round(n).toLocaleString()}`;
const inputStyle = { fontSize: 12, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' };

// stats: Map `${brand}|${creativeKey}|${state}` → { leads, spend } over the Relaunch lead window
export default function LaunchAnywhere({ library, groups, stats, since }) {
  const [targets, setTargets] = useState(null);   // [{ brand, state, templates, liveCampaigns }]
  const [error, setError] = useState('');
  const [brand, setBrand] = useState(() => localStorage.getItem('launchAnyBrand') || 'LSS');
  const [states, setStates] = useState([]);       // chosen states, in click order
  const [ads, setAds] = useState([]);             // ads added here (go to every chosen state)
  const [picked, setPicked] = useState({});       // state → Set of ad names still to launch there
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const panel = useRef(null);

  useEffect(() => {
    if (!open || targets) return;
    let live = true;
    fetch(`${BASE}/api/admanage/groups`).then(async r => {
      const d = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(d)) throw new Error(d?.error || r.statusText);
      if (live) setTargets(d);
    }).catch(e => live && setError(e.message));
    return () => { live = false; };
  }, [open, targets]);

  const byKey = useMemo(() => new Map(groups.map(g => [g.key, g])), [groups]);
  const findGroup = name => {
    const k = creativeKey(name);
    if (byKey.has(k)) return byKey.get(k);
    const q = String(name).trim().toLowerCase();
    const hits = groups.filter(g => g.name.toLowerCase().includes(q));
    return hits.length === 1 ? hits[0] : null;
  };

  function addAds(names) {
    const found = [], missed = [];
    for (const n of names.map(s => s.trim()).filter(Boolean)) {
      const g = findGroup(n);
      if (g) found.push(g.name); else missed.push(n);
    }
    setAds(a => [...a, ...found.filter(n => !a.includes(n))]);
    setPicked(p => Object.fromEntries(Object.entries(p).map(([st, set]) => [st, new Set([...set, ...found])])));
    setNote(missed.length ? `Not in the local library: ${missed.join(', ')}` : '');
    return found.length;
  }
  function removeAd(name) {
    setAds(a => a.filter(n => n !== name));
    setPicked(p => Object.fromEntries(Object.entries(p).map(([st, set]) => { const s = new Set(set); s.delete(name); return [st, s]; })));
  }
  function toggleState(st) {
    if (states.includes(st)) {
      setStates(s => s.filter(x => x !== st));
      setPicked(p => { const n = { ...p }; delete n[st]; return n; });
    } else {
      setStates(s => [...s, st]);
      setPicked(p => ({ ...p, [st]: new Set(ads) }));
    }
  }
  function chooseBrand(b) {
    setBrand(b); setStates([]); setPicked({});
    try { localStorage.setItem('launchAnyBrand', b); } catch { /* storage blocked */ }
  }
  const pickIn = (st, name, on) => setPicked(p => {
    const s = new Set(p[st] || []);
    if (on) s.add(name); else s.delete(name);
    return { ...p, [st]: s };
  });

  // "Launch…" from Ads Tracking
  useEffect(() => {
    const take = e => {
      if (e) setOpen(true);
      if (!groups.length) return;   // library still loading: the request waits until it has files
      const names = takeLaunchRequests();
      if (!names.length) return;
      setOpen(true);
      addAds(names);
      setTimeout(() => panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };
    take();
    window.addEventListener(LAUNCH_EVENT, take);
    return () => window.removeEventListener(LAUNCH_EVENT, take);
  }); // re-subscribes each render so addAds sees the current library

  const brands = useMemo(() => [...new Set((targets || []).map(t => t.brand))], [targets]);
  const brandTargets = (targets || []).filter(t => t.brand === brand);
  const matches = query.trim().length < 2 ? [] : groups
    .filter(g => g.name.toLowerCase().includes(query.trim().toLowerCase()) && !ads.includes(g.name)).slice(0, 8);
  const stat = (name, st) => stats.get(`${brand}|${creativeKey(name)}|${st}`);
  const everywhere = name => {
    const k = `${brand}|${creativeKey(name)}|`;
    let leads = 0, spend = 0, any = false;
    for (const [key, v] of stats) if (key.startsWith(k)) { leads += v.leads; spend += v.spend; any = true; }
    return any ? { leads, spend } : null;
  };
  const cell = v => !v ? <span style={{ color: 'var(--text-muted)' }}>never run</span>
    : <><strong>{v.leads}</strong> <span style={{ color: 'var(--text-muted)' }}>{v.leads ? `${money(v.spend / v.leads)} CPL` : `${money(v.spend)} spent`}</span></>;

  const box = { fontSize: 12, padding: '12px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, marginBottom: 22 };
  const th = { padding: '5px 8px', fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' };
  const td = { padding: '4px 8px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '1px solid var(--border)' };

  if (!open) return (
    <div ref={panel} style={{ ...box, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontWeight: 700, fontSize: 14 }}>Launch any ad</span>
      <span style={{ color: 'var(--text-muted)' }}>any creative in the library, into any state — not only the picks below</span>
      <button className="btn btn--sm" onClick={() => setOpen(true)}>Open</button>
    </div>
  );

  return (
    <div ref={panel} style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Launch any ad</span>
        {brands.length > 0 && <select value={brand} onChange={e => chooseBrand(e.target.value)}>{brands.map(b => <option key={b}>{b}</option>)}</select>}
        <span style={{ color: 'var(--text-muted)' }}>pick states, add ads, then save a draft per state below</span>
        <button className="btn btn--sm" style={{ marginLeft: 'auto' }} onClick={() => setOpen(false)}>Close</button>
      </div>
      {error && <div style={{ color: '#fb9292', marginBottom: 8 }}>AdManage: {error}</div>}
      {!targets && !error && <div style={{ color: 'var(--text-muted)' }}>Loading AdManage states…</div>}

      {targets && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: 10 }}>
          {brandTargets.length === 0 && <span style={{ color: 'var(--text-muted)' }}>No {brand} copy templates in AdManage.</span>}
          {brandTargets.map(t => (
            <label key={t.state} style={{ display: 'flex', alignItems: 'center', gap: 4, color: t.liveCampaigns ? undefined : 'var(--text-muted)' }}
              title={t.liveCampaigns ? `${t.liveCampaigns} live ${brand} ${t.state} campaign${t.liveCampaigns > 1 ? 's' : ''}` : `No live ${brand} ${t.state} campaign in AdManage`}>
              <input type="checkbox" checked={states.includes(t.state)} onChange={() => toggleState(t.state)} disabled={!t.liveCampaigns} />
              {t.state}
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Add an ad by name (or paste several, one per line)…"
            onPaste={e => {
              const text = e.clipboardData.getData('text');
              if (/[\n,]/.test(text.trim())) { e.preventDefault(); addAds(text.split(/[\n,]+/)); }
            }}
            onKeyDown={e => { if (e.key === 'Enter' && query.trim() && addAds([query])) setQuery(''); }}
            style={{ ...inputStyle, width: 340 }} />
          {matches.map(g => (
            <div key={g.key}><button className="btn btn--sm" style={{ marginTop: 2 }} onClick={() => { addAds([g.name]); setQuery(''); }}>+ {g.name}</button></div>
          ))}
        </div>
        {!library.connected && <span style={{ color: '#fb9292' }}>Local creative library not connected.</span>}
      </div>
      {note && <div style={{ color: '#f2bd65', marginBottom: 6 }}>{note}</div>}

      {ads.length > 0 && (
        <div style={{ overflowX: 'auto', marginBottom: 12 }}>
          <table style={{ borderCollapse: 'collapse', minWidth: 0 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Ad</th>
                <th style={th} title={`${brand} leads and CPL in every state since ${since}`}>All {brand} states</th>
                {states.map(st => <th key={st} style={th} title={`${brand} ${st} leads and CPL since ${since}`}>{st}</th>)}
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {ads.map(name => (
                <tr key={name}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{name}</td>
                  <td style={td}>{cell(everywhere(name))}</td>
                  {states.map(st => <td key={st} style={td}>{cell(stat(name, st))}</td>)}
                  <td style={td}><button className="btn btn--sm" onClick={() => removeAd(name)} title="Remove from every state">✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Leads · CPL since {since}.</div>
        </div>
      )}

      {states.map(st => (
        <div key={st} style={{ marginBottom: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 13, margin: '8px 0 4px' }}>{brand} {st}</div>
          <AdManageLaunch brand={brand} state={st} groups={groups} library={library} picked={picked[st] || new Set()}
            onPick={name => pickIn(st, name, true)} onUnpick={name => pickIn(st, name, false)} />
        </div>
      ))}
      {targets && states.length === 0 && <div style={{ color: 'var(--text-muted)' }}>Tick one or more states to get a launcher for each.</div>}
    </div>
  );
}
