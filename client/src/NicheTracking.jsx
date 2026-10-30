// Ads Tracking for the insurance niche sites: one row per ad name, one column per campaign,
// each cell the ad's Facebook leads (the campaign's own result) and CPL over the chosen range.
// Reads only /api/facebook/ads, so it never writes to sheets or CRMs like the law tab does.

import { useEffect, useMemo, useState } from 'react';
import { NICHE_LABEL } from './niche.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const RANGES = ['Last 7 Days', 'Last 14 Days', 'Last 30 Days', 'This Month', 'Last Month', 'Lifetime'];
const RANGE_KEY = 'nicheTrackingRange';

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function rangeQuery(range) {
  if (range === 'Lifetime') return 'date_preset=maximum';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = n => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  const [start, end] = {
    'Last 7 Days':  [back(6), today],
    'Last 14 Days': [back(13), today],
    'Last 30 Days': [back(29), today],
    'This Month':   [new Date(today.getFullYear(), today.getMonth(), 1), today],
    'Last Month':   [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)],
  }[range];
  return `start=${iso(start)}&end=${iso(end)}`;
}

const money = n => `$${Math.round(n).toLocaleString()}`;
const cpl = (spend, leads) => (leads > 0 ? money(spend / leads) : spend > 0 ? '—' : '');
const isActive = a => (a.effectiveStatus || a.status) === 'ACTIVE';

export default function NicheTracking() {
  const [range, setRange] = useState(() => localStorage.getItem(RANGE_KEY) || 'This Month');
  const [ads, setAds] = useState(null);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('leads');
  const [activeOnly, setActiveOnly] = useState(false);

  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    fetch(`${BASE}/api/facebook/ads?${rangeQuery(range)}${reload ? '&force=1' : ''}`)
      .then(async r => {
        const data = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(data)) throw new Error(data?.error || r.statusText);
        if (!live) return;
        setAds(data);
        setStale(parseInt(r.headers.get('X-Stale-Minutes'), 10) || 0);
        const failed = r.headers.get('X-FB-Failed-Accounts');
        if (failed) setError(`couldn't read ad account ${failed.replace(/act_/g, '')} (the token's system user may not have access to it in Business Manager)`);
      })
      .catch(e => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [range, reload]);

  const { campaigns, rows, totals } = useMemo(() => {
    const campaigns = new Map();   // id → { id, name, spend, leads, active }
    const rows = new Map();        // ad name → { name, spend, leads, active, cells: { campaignId → cell } }
    for (const a of ads || []) {
      const spend = parseFloat(a.spend) || 0;
      const leads = a.results || 0;
      const active = isActive(a);
      if (!spend && !leads && !active) continue;
      const name = (a.name || '').trim() || '(no name)';
      const c = campaigns.get(a.campaignId) || { id: a.campaignId, name: a.campaignName || a.campaignId, spend: 0, leads: 0, active: false };
      c.spend += spend; c.leads += leads; c.active ||= active;
      campaigns.set(a.campaignId, c);
      const row = rows.get(name) || { name, spend: 0, leads: 0, active: false, cells: {} };
      row.spend += spend; row.leads += leads; row.active ||= active;
      const cell = row.cells[a.campaignId] || { spend: 0, leads: 0, active: false, ads: 0 };
      cell.spend += spend; cell.leads += leads; cell.active ||= active; cell.ads++;
      row.cells[a.campaignId] = cell;
      rows.set(name, row);
    }
    const totals = { spend: 0, leads: 0 };
    for (const c of campaigns.values()) { totals.spend += c.spend; totals.leads += c.leads; }
    return { campaigns: [...campaigns.values()].sort((a, b) => b.spend - a.spend), rows: [...rows.values()], totals };
  }, [ads]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cplOf = r => (r.leads ? r.spend / r.leads : Infinity);
    return rows
      .filter(r => (!q || r.name.toLowerCase().includes(q)) && (!activeOnly || r.active))
      .sort(sort === 'spend' ? (a, b) => b.spend - a.spend
        : sort === 'cpl' ? (a, b) => cplOf(a) - cplOf(b) || b.spend - a.spend
        : sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
        : (a, b) => b.leads - a.leads || b.spend - a.spend);
  }, [rows, query, sort, activeOnly]);

  const th = { padding: '8px 10px', fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap', verticalAlign: 'bottom' };
  const td = { padding: '6px 10px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' };
  const sticky = { position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1, textAlign: 'left' };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{NICHE_LABEL} — Ads Tracking</h2>
        <select value={range} onChange={e => { setRange(e.target.value); localStorage.setItem(RANGE_KEY, e.target.value); }}>
          {RANGES.map(r => <option key={r}>{r}</option>)}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)}>
          <option value="leads">Sort: most leads</option>
          <option value="cpl">Sort: lowest CPL</option>
          <option value="spend">Sort: most spend</option>
          <option value="name">Sort: name</option>
        </select>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ads…"
          style={{ fontSize: 12, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }} />
        <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
          <input type="checkbox" checked={activeOnly} onChange={e => setActiveOnly(e.target.checked)} /> Live ads only
        </label>
        <button className="btn btn--sm" onClick={() => setReload(n => n + 1)} disabled={loading}>{loading ? 'Loading…' : 'Refresh from Facebook'}</button>
        {ads && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {money(totals.spend)} spend · {totals.leads} leads · {cpl(totals.spend, totals.leads) || '—'} CPL
          {stale ? ` · showing data from ${stale} min ago (Facebook rate limit)` : ''}
        </span>}
      </div>

      {error && <div style={{ color: '#fb9292', marginBottom: 10 }}>Facebook: {error}</div>}
      {!ads && !error && <div style={{ color: 'var(--text-muted)' }}>Loading ads from Facebook…</div>}
      {ads && campaigns.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No spend or live ads in this range.</div>}

      {ads && campaigns.length > 0 && (
        <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 190px)', overflow: 'auto' }}>
          <table style={{ minWidth: 0 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
              <tr>
                <th style={{ ...th, ...sticky, zIndex: 3 }}>Ad ({shown.length})</th>
                <th style={th}>Total<div style={{ fontWeight: 400, textTransform: 'none' }}>leads · CPL</div></th>
                {campaigns.map(c => (
                  <th key={c.id} style={{ ...th, maxWidth: 160, whiteSpace: 'normal' }} title={c.name}>
                    <span style={{ color: c.active ? 'var(--green-dark)' : undefined }}>{c.active ? '● ' : ''}{c.name}</span>
                    <div style={{ fontWeight: 400, textTransform: 'none' }}>{c.leads} · {cpl(c.spend, c.leads) || '—'} · {money(c.spend)}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map(r => (
                <tr key={r.name}>
                  <td style={{ ...td, ...sticky, fontWeight: 600, maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>
                    {r.active && <span style={{ color: 'var(--green-dark)' }} title="Live in at least one campaign">● </span>}{r.name}
                  </td>
                  <td style={{ ...td, fontWeight: 600 }} title={`${money(r.spend)} spend`}>{r.leads} · {cpl(r.spend, r.leads) || '—'}</td>
                  {campaigns.map(c => {
                    const cell = r.cells[c.id];
                    if (!cell) return <td key={c.id} style={{ ...td, color: 'var(--border)' }}>·</td>;
                    return (
                      <td key={c.id} title={`${money(cell.spend)} spend${cell.active ? ' · live' : ''}${cell.ads > 1 ? ` · ${cell.ads} ads with this name` : ''}`}
                        style={{ ...td, background: cell.active ? 'var(--green-light)' : undefined }}>
                        <strong>{cell.leads}</strong> <span style={{ color: 'var(--text-muted)' }}>{cpl(cell.spend, cell.leads)}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
        Leads = each campaign's Facebook result (lead form or pixel lead). Green cells are ads live in that campaign; ads with the same name are combined.
      </div>
    </div>
  );
}
