// Spend Sheet for the insurance niche sites: a monthly budget per campaign, paced against this
// month's Facebook spend, with each live campaign's current daily budget. Budgets are shared
// across devices through the synced localStorage key 'niche_budgets' ({ campaignId: dollars }).

import { useEffect, useMemo, useState } from 'react';
import { lsSet } from './sync.js';
import { NICHE_LABEL } from './niche.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const BUDGETS_KEY = 'niche_budgets';

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const money = n => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString()}`;
function savedBudgets() {
  try { return JSON.parse(localStorage.getItem(BUDGETS_KEY) || '{}'); } catch { return {}; }
}
async function getJson(path) {
  const r = await fetch(`${BASE}${path}`);
  const data = await r.json().catch(() => null);
  if (!r.ok || !data) throw new Error(data?.error || r.statusText);
  return data;
}

export default function NicheSpend() {
  const [spend, setSpend] = useState(null);       // [{ campaign_id, campaign_name, spend }]
  const [adsets, setAdsets] = useState(null);     // metadata-only ad sets (budgets + status)
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [budgets, setBudgets] = useState(savedBudgets);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const day = now.getDate();
  const daysLeft = daysInMonth - day + 1;   // including today
  const monthLabel = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  useEffect(() => {
    let live = true;
    const force = reload ? '&force=1' : '';
    setLoading(true); setError('');
    Promise.all([
      getJson(`/api/facebook/campaign-spend?since=${iso(monthStart)}&until=${iso(new Date())}${force}`),
      getJson(`/api/facebook/adsets?metadata_only=true${force}`),
    ])
      .then(([s, a]) => { if (live) { setSpend(s); setAdsets(a); } })
      .catch(e => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const rows = useMemo(() => {
    if (!spend || !adsets) return [];
    const byId = new Map();
    const row = (id, name) => byId.get(id) || byId.set(id, { id, name, spent: 0, live: false, daily: 0, cbo: 0 }).get(id);
    for (const s of spend) row(s.campaign_id, s.campaign_name).spent += s.spend || 0;
    for (const a of adsets) {
      const r = row(a.campaignId, a.campaignName);
      if (a.effectiveStatus !== 'ACTIVE') continue;
      r.live = true;
      // Campaign budget (CBO) covers all its ad sets; otherwise add up the live ad sets' budgets (cents)
      if (a.campaignDailyBudget) r.cbo = parseInt(a.campaignDailyBudget, 10) / 100;
      else r.daily += (parseInt(a.dailyBudget, 10) || 0) / 100;
    }
    return [...byId.values()]
      .filter(r => r.spent > 0 || r.live || budgets[r.id])
      .map(r => ({ ...r, daily: r.cbo || r.daily }))
      .sort((a, b) => Number(b.live) - Number(a.live) || b.spent - a.spent);
  }, [spend, adsets, budgets]);

  function setBudget(id, value) {
    const next = { ...budgets };
    const n = parseFloat(String(value).replace(/[$,]/g, ''));
    if (n > 0) next[id] = n; else delete next[id];
    setBudgets(next);
    lsSet(BUDGETS_KEY, JSON.stringify(next));
  }

  const pace = r => {
    const budget = budgets[r.id] || 0;
    const target = budget * day / daysInMonth;
    return { budget, target, diff: r.spent - target, remaining: budget - r.spent, perDay: (budget - r.spent) / daysLeft };
  };
  const total = rows.reduce((t, r) => {
    const p = pace(r);
    return { spent: t.spent + r.spent, daily: t.daily + (r.live ? r.daily : 0), budget: t.budget + p.budget, target: t.target + p.target };
  }, { spent: 0, daily: 0, budget: 0, target: 0 });

  const th = { padding: '8px 10px', fontSize: 11, textAlign: 'right', whiteSpace: 'nowrap' };
  const td = { padding: '6px 10px', fontSize: 12, textAlign: 'right', whiteSpace: 'nowrap' };
  const diffColor = d => (Math.abs(d) < 1 ? undefined : d > 0 ? '#f2bd65' : '#fb9292');

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{NICHE_LABEL} — Spend Sheet · {monthLabel}</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Day {day} of {daysInMonth} · {daysLeft} days left incl. today</span>
        <button className="btn btn--sm" onClick={() => setReload(n => n + 1)} disabled={loading}>{loading ? 'Loading…' : 'Refresh from Facebook'}</button>
      </div>
      {error && <div style={{ color: '#fb9292', marginBottom: 10 }}>Facebook: {error}</div>}
      {!spend && !error && <div style={{ color: 'var(--text-muted)' }}>Loading spend and budgets from Facebook…</div>}
      {spend && rows.length === 0 && <div style={{ color: 'var(--text-muted)' }}>No campaigns with spend or live ad sets this month.</div>}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table style={{ minWidth: 0 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Campaign</th>
                <th style={th}>Live daily budget</th>
                <th style={th}>Monthly budget</th>
                <th style={th}>Spent this month</th>
                <th style={th}>Target by today</th>
                <th style={th}>Over / under pace</th>
                <th style={th}>Remaining</th>
                <th style={th}>Needed per day</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const p = pace(r);
                return (
                  <tr key={r.id}>
                    <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>
                      <span style={{ color: r.live ? 'var(--green-dark)' : 'var(--text-muted)' }} title={r.live ? 'Live' : 'Off'}>●</span> {r.name}
                    </td>
                    <td style={td}>{r.live ? money(r.daily) : <span style={{ color: 'var(--text-muted)' }}>off</span>}</td>
                    <td style={td}>
                      <input defaultValue={budgets[r.id] || ''} placeholder="$ budget" onBlur={e => setBudget(r.id, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                        style={{ width: 90, textAlign: 'right', fontSize: 12, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }} />
                    </td>
                    <td style={td}>{money(r.spent)}</td>
                    {p.budget ? <>
                      <td style={td}>{money(p.target)}</td>
                      <td style={{ ...td, color: diffColor(p.diff), fontWeight: 600 }}>{p.diff > 0 ? '+' : ''}{money(p.diff)}</td>
                      <td style={td}>{money(p.remaining)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{p.remaining > 0 ? money(p.perDay) : '—'}</td>
                    </> : <td colSpan={4} style={{ ...td, color: 'var(--text-muted)', textAlign: 'center' }}>set a monthly budget to see pacing</td>}
                  </tr>
                );
              })}
              <tr style={{ fontWeight: 700 }}>
                <td style={{ ...td, textAlign: 'left' }}>Total</td>
                <td style={td}>{money(total.daily)}</td>
                <td style={td}>{total.budget ? money(total.budget) : ''}</td>
                <td style={td}>{money(total.spent)}</td>
                <td style={td}>{total.budget ? money(total.target) : ''}</td>
                <td style={td} colSpan={3}></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
        Over pace (amber) = spent more than an even daily split of the monthly budget; under pace (red) = behind it.
        Budgets are saved for everyone using this site.
      </div>
    </div>
  );
}
