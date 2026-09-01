import { useState, useEffect, useMemo } from 'react';
import { dbGetAll, dbGetMeta } from './db.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

// Same helpers as the Ads Tracking / Spend Sheet tabs — the naming convention
// is the shared contract between all of them.
function extractState(campaignName) {
  if (!campaignName) return null;
  const tokens = campaignName.trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase();
    if (US_STATES.has(t)) return t;
  }
  return null;
}
function extractBrand(campaignName) {
  if (!campaignName) return 'LSS';
  const tokens = campaignName.split(/[-–—\s_/|]+/).map(t => t.toUpperCase());
  if (tokens.includes('HALO'))     return 'Halo';
  if (tokens.includes('BULKTIDE')) return 'Bulktide';
  return 'LSS';
}
function stripStateSegments(adName) {
  const base = adName
    .replace(/\s*[-–—]?\s*\bLSS[ _-]([A-Za-z]{2})\b/gi, (m, st) => (US_STATES.has(st.toUpperCase()) ? '' : m))
    .replace(/\s{2,}/g, ' ')
    .replace(/[-\s]+$/, '')
    .trim() || adName;
  const parts = base.split('-');
  const kept  = parts.filter(p => !US_STATES.has(p.trim().toUpperCase()));
  return kept.length && kept.length < parts.length ? kept.join('-') : base;
}
const CITY_TERMS = ['lubbock', 'bexar', 'harris', 'tarrant'];
function isCityAd(adName) {
  const tokens = (adName || '').toLowerCase().split(/[^a-z]+/);
  return CITY_TERMS.some(c => tokens.includes(c));
}

// Pacing helpers (mirrors Spend Sheet)
const PACING_KEY = 'spend_pacing_v2';
function loadPacing() {
  try { return JSON.parse(localStorage.getItem(PACING_KEY) || '{}'); } catch { return {}; }
}
function monthsBetween(startDate, endDate) {
  if (!startDate || !endDate) return [];
  const months = [];
  const s = new Date(startDate + 'T00:00:00');
  const e = new Date(endDate   + 'T00:00:00');
  let cur  = new Date(s.getFullYear(), s.getMonth(), 1);
  const last = new Date(e.getFullYear(), e.getMonth(), 1);
  while (cur <= last) {
    months.push(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`);
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return months;
}
function daysLeft(endDate, tz = 'America/New_York') {
  if (!endDate) return null;
  const now = new Date();
  const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const end = new Date(endDate + 'T00:00:00');
  const todayMidnight = new Date(todayStr + 'T00:00:00');
  const full = Math.floor((end - todayMidnight) / 86400000);
  if (full < 0) return 0;
  return Math.max(1, full + 0.5);
}

const LEAD_CUTOFF = '2026-04-20'; // same lead window default as the Ads Tracking tab

function fmt(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

// Score components — leads first, CPL second, cases a light third (user may
// not have updated cases; never let a stale zero sink a proven ad).
function scoreCandidate({ leads, cpl, cases }) {
  const leadsScore = Math.min(1, Math.log10(1 + leads) / Math.log10(41));      // 40+ leads maxes out
  const cplScore   = cpl == null ? 0.3 : Math.max(0, Math.min(1, (600 - cpl) / 450)); // $150→1, $600→0
  const casesScore = Math.min(1, cases / 3);
  return 0.5 * leadsScore + 0.35 * cplScore + 0.15 * casesScore;
}

export default function Relaunch() {
  const [allAds, setAllAds]           = useState([]);
  const [windowAds, setWindowAds]     = useState([]);
  const [deletedAds, setDeletedAds]   = useState(new Set());
  const [mergeGroups, setMergeGroups] = useState([]);
  const [sheetCases, setSheetCases]   = useState([]);
  const [ghlContacts, setGhlContacts] = useState([]);
  const [budgetByGroup, setBudgetByGroup] = useState({});
  const [pacingSpend, setPacingSpend]     = useState({});
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [loadedAt, setLoadedAt] = useState(null);
  const [reuseMonths, setReuseMonths] = useState(() => parseInt(localStorage.getItem('reuseThresholdMonths'), 10) || 2);
  const [minLeads, setMinLeads]       = useState(() => parseInt(localStorage.getItem('relaunchMinLeads'), 10) || 3);

  const pacing = useMemo(() => loadPacing(), [loadedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    setLoading(true);
    setError('');
    try {
      const today = new Date().toISOString().slice(0, 10);
      // Local caches first (populated by the Ads Tracking tab's syncs)
      const [ads, deleted, merges, casesData, ghl] = await Promise.all([
        dbGetAll('fbAds'),
        dbGetMeta('deletedAds'),
        dbGetMeta('mergeGroups'),
        dbGetMeta('sheetCasesData'),
        dbGetAll('ghlContacts'),
      ]);
      setAllAds(ads || []);
      setDeletedAds(new Set(deleted || []));
      setMergeGroups(merges || []);
      setSheetCases(casesData?.cases || []);
      setGhlContacts(ghl || []);

      // Server-cached endpoints — same cache keys the other tabs warm, so this
      // usually costs ZERO new FB calls.
      const [winAds, adsets] = await Promise.all([
        apiFetch(`/api/facebook/ads?start=${LEAD_CUTOFF}&end=${today}`),
        apiFetch('/api/facebook/adsets?metadata_only=true'),
      ]);
      setWindowAds(winAds || []);

      // Live daily budget per '<brand> <state>' group (mirrors Spend Sheet)
      const budget = {};
      const counted = new Set();
      for (const a of adsets || []) {
        if (a.effectiveStatus !== 'ACTIVE') continue;
        const st = extractState(a.campaignName);
        if (!st) continue;
        const group = `${extractBrand(a.campaignName)} ${st}`;
        const adsetBudget = parseFloat(a.dailyBudget) / 100 || 0;
        if (adsetBudget > 0) budget[group] = (budget[group] || 0) + adsetBudget;
        else {
          const campBudget = parseFloat(a.campaignDailyBudget) / 100 || 0;
          if (campBudget > 0 && !counted.has(a.campaignId)) {
            counted.add(a.campaignId);
            budget[group] = (budget[group] || 0) + campBudget;
          }
        }
      }
      setBudgetByGroup(budget);

      // Spent-to-date per group — one campaign-spend call per unique start date
      const cfg = loadPacing();
      const dates = [...new Set(Object.values(cfg).map(c => c?.startDate).filter(Boolean))];
      const spend = {};
      for (const since of dates) {
        const rows = await apiFetch(`/api/facebook/campaign-spend?since=${since}&until=${today}`);
        const groupsForDate = new Set(Object.entries(cfg).filter(([, c]) => c?.startDate === since).map(([g]) => g));
        for (const r of rows || []) {
          const st = extractState(r.campaign_name);
          if (!st) continue;
          const group = `${extractBrand(r.campaign_name)} ${st}`;
          if (groupsForDate.has(group)) spend[group] = (spend[group] || 0) + (r.spend || 0);
        }
      }
      setPacingSpend(spend);
      setLoadedAt(Date.now());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Canonical ad names (manual merges win, then auto state-fold) ────────────
  const memberToCanonical = useMemo(() => {
    const manualMembers = new Set(mergeGroups.flatMap(g => g.members));
    const byBase = new Map();
    for (const a of allAds) {
      const name = (a.name || '').trim();
      if (!name || manualMembers.has(name)) continue;
      const base = stripStateSegments(name);
      if (!byBase.has(base)) byBase.set(base, new Set());
      byBase.get(base).add(name);
    }
    const map = {};
    for (const g of mergeGroups) for (const m of g.members) map[m] = g.canonical;
    for (const [base, set] of byBase) {
      if (set.size < 2) continue;
      for (const m of set) if (!map[m]) map[m] = base;
    }
    return map;
  }, [mergeGroups, allAds]);

  const canonical = n => memberToCanonical[(n || '').trim()] || (n || '').trim();

  // ── Per-ad evidence: leads/spend per brand|ad|state from the lead window ────
  const windowAgg = useMemo(() => {
    const map = new Map(); // `${brand}|${ad}|${state}` → {leads, spend}
    for (const a of windowAds) {
      const name = canonical(a.name);
      const st = extractState(a.campaignName);
      if (!name || !st || deletedAds.has((a.name || '').trim())) continue;
      const key = `${extractBrand(a.campaignName)}|${name}|${st}`;
      const cell = map.get(key) || { leads: 0, spend: 0 };
      cell.leads += a.results || 0;
      cell.spend += parseFloat(a.spend) || 0;
      map.set(key, cell);
    }
    return map;
  }, [windowAds, deletedAds, memberToCanonical]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cases per ad|state (sheet cases attributed by utm_content; LSS business only)
  const caseAgg = useMemo(() => {
    const ghlByPhone = {};
    for (const c of ghlContacts) {
      const key = (c.phone || '').replace(/\D/g, '').slice(-10);
      if (key && (!ghlByPhone[key] || (!ghlByPhone[key].utmContent && c.utmContent))) ghlByPhone[key] = c;
    }
    const map = new Map(); // `${ad}|${state}` → count
    for (const sc of sheetCases) {
      let utm = sc.utmContent;
      if (!utm) utm = ghlByPhone[(sc.phone || '').replace(/\D/g, '').slice(-10)]?.utmContent;
      if (!utm) continue;
      const name = canonical(utm);
      const st = (sc.state || '').toUpperCase();
      if (!name || !st) continue;
      const key = `${name}|${st}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [sheetCases, ghlContacts, memberToCanonical]); // eslint-disable-line react-hooks/exhaustive-deps

  // Usage/dormancy per ad|state from the full ads list
  const usage = useMemo(() => {
    const map = new Map(); // `${ad}|${state}` → { active, last }
    const statesByAd = new Map(); // ad → Set(states it ever ran in)
    const activeStatesByAd = new Map();
    for (const a of allAds) {
      const name = canonical(a.name);
      const st = extractState(a.campaignName);
      if (!name || !st) continue;
      const key = `${name}|${st}`;
      const cell = map.get(key) || { active: false, last: null };
      if ((a.effectiveStatus || a.status) === 'ACTIVE') {
        cell.active = true;
        if (!activeStatesByAd.has(name)) activeStatesByAd.set(name, new Set());
        activeStatesByAd.get(name).add(st);
      }
      const t = a.updatedTime || a.createdTime;
      if (t && (!cell.last || t > cell.last)) cell.last = t;
      map.set(key, cell);
      if (!statesByAd.has(name)) statesByAd.set(name, new Set());
      statesByAd.get(name).add(st);
    }
    return { map, statesByAd, activeStatesByAd };
  }, [allAds, memberToCanonical]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Underspending groups from pacing config ─────────────────────────────────
  const shortfalls = useMemo(() => {
    const rows = [];
    for (const [group, cfg] of Object.entries(pacing)) {
      if (!cfg?.startDate || !cfg?.endDate) continue;
      const months = monthsBetween(cfg.startDate, cfg.endDate);
      const totalBudget = months.reduce((s, ym) => s + (parseFloat(cfg.monthlyBudgets?.[ym]) || 0), 0);
      if (!totalBudget) continue;
      const dl = daysLeft(cfg.endDate, cfg.timezone || 'America/New_York');
      if (dl === 0) continue; // period over
      const spent = pacingSpend[group];
      if (spent == null) continue;
      const remaining   = Math.max(0, totalBudget - spent);
      const dailyNeeded = remaining / dl;
      const liveBudget  = budgetByGroup[group] || 0;
      const shortfall   = dailyNeeded - liveBudget;
      if (shortfall > 1) rows.push({ group, brand: group.split(' ')[0], state: group.split(' ').slice(-1)[0], shortfall, dailyNeeded, liveBudget, remaining, daysLeft: dl });
    }
    return rows.sort((a, b) => b.shortfall - a.shortfall);
  }, [pacing, pacingSpend, budgetByGroup]);

  // ── Recommendations per underspending group ────────────────────────────────
  const recommendations = useMemo(() => {
    const dormantCutoff = Date.now() - reuseMonths * 30 * 24 * 3600 * 1000;
    // All canonical ad names with any evidence for a given brand
    const adsByBrand = new Map();
    for (const key of windowAgg.keys()) {
      const [brand, name] = key.split('|');
      if (!adsByBrand.has(brand)) adsByBrand.set(brand, new Set());
      adsByBrand.get(brand).add(name);
    }

    return shortfalls.map(sf => {
      const candidates = [];
      for (const name of adsByBrand.get(sf.brand) || []) {
        if (isCityAd(name)) continue;
        const usedHere = usage.statesByAd.get(name)?.has(sf.state);
        const cell     = usage.map.get(`${name}|${sf.state}`);

        // Stats split: "here" = the underspending state, "total" = every state
        // (brand-scoped). Both are shown so the ranking is auditable at a glance.
        let totalLeads = 0, totalSpend = 0, totalCases = 0;
        const proven = [];
        for (const [key, v] of windowAgg) {
          const [b, n, st] = key.split('|');
          if (b !== sf.brand || n !== name) continue;
          totalLeads += v.leads; totalSpend += v.spend;
          totalCases += caseAgg.get(`${n}|${st}`) || 0;
          if (st !== sf.state && v.leads > 0) proven.push({ st, leads: v.leads });
        }
        const here = windowAgg.get(`${sf.brand}|${name}|${sf.state}`) || { leads: 0, spend: 0 };
        const hereLeads = here.leads;
        const hereCpl   = hereLeads > 0 && here.spend > 0 ? here.spend / hereLeads : null;
        const totalCpl  = totalLeads > 0 && totalSpend > 0 ? totalSpend / totalLeads : null;

        const base = {
          name,
          hereLeads, hereCpl,
          totalLeads, totalCpl,
          cases: totalCases,
          lastUsedHere: usedHere ? (cell?.last || null) : null,
          usedHere: !!usedHere,
          provenIn: proven.sort((a, b) => b.leads - a.leads),
          activeNow: [...(usage.activeStatesByAd.get(name) || [])],
        };

        if (!usedHere) {
          // Tier 1 — proven elsewhere, never run in this state
          const otherLeads = totalLeads - hereLeads;
          const otherSpend = totalSpend - here.spend;
          if (otherLeads < minLeads) continue;
          const otherCpl = otherLeads > 0 && otherSpend > 0 ? otherSpend / otherLeads : null;
          candidates.push({ ...base, tier: 1, score: scoreCandidate({ leads: otherLeads, cpl: otherCpl, cases: totalCases }) });
        } else {
          // Tier 2 — ran here before, dormant past the threshold, did well here
          if (cell?.active) continue;
          if (!cell?.last || new Date(cell.last).getTime() >= dormantCutoff) continue;
          if (hereLeads < minLeads) continue;
          const hereCases = caseAgg.get(`${name}|${sf.state}`) || 0;
          candidates.push({ ...base, tier: 2, score: scoreCandidate({ leads: hereLeads, cpl: hereCpl, cases: hereCases }) });
        }
      }
      candidates.sort((a, b) => a.tier - b.tier || b.score - a.score);
      return { ...sf, candidates: candidates.slice(0, 25) };
    });
  }, [shortfalls, windowAgg, caseAgg, usage, reuseMonths, minLeads]);

  // ── Styles ───────────────────────────────────────────────────────────────────
  const th = { padding: '7px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap', borderBottom: '2px solid var(--border)', background: 'var(--surface)' };
  const thL = { ...th, textAlign: 'left' };
  const td = { padding: '7px 10px', fontSize: 12, textAlign: 'right', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' };
  const tdL = { ...td, textAlign: 'left', whiteSpace: 'normal' };

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Relaunch</div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          fills each underspending state with the smartest ads to put live — best picks first
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            Dormant ≥
            <input type="number" min="1" value={reuseMonths}
              onChange={e => { const v = Math.max(1, parseInt(e.target.value, 10) || 2); setReuseMonths(v); localStorage.setItem('reuseThresholdMonths', String(v)); }}
              style={{ width: 44, fontSize: 12, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }} />
            mo
          </label>
          <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            Min leads
            <input type="number" min="1" value={minLeads}
              onChange={e => { const v = Math.max(1, parseInt(e.target.value, 10) || 3); setMinLeads(v); localStorage.setItem('relaunchMinLeads', String(v)); }}
              style={{ width: 44, fontSize: 12, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)', color: 'var(--text)' }} />
          </label>
          <button className="btn btn--sm" onClick={load} disabled={loading}>{loading ? 'Loading…' : '↺ Refresh'}</button>
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 18 }}>
        Underspend comes from the Spend Sheet pacing config · performance window since {LEAD_CUTOFF} · ranked by leads, then CPL, then cases ·
        <strong> NEW</strong> = never run in that state (proven elsewhere) · <strong>RELAUNCH</strong> = did well there, dormant ≥{reuseMonths} mo ·
        "Last used" shows <strong>Never – 0</strong> or <strong>date – leads it got in that state</strong>
      </div>

      {error && <div style={{ fontSize: 12, color: '#dc2626', padding: '10px 14px', background: 'rgba(220,38,38,0.06)', border: '1px solid #dc2626', borderRadius: 8, marginBottom: 14 }}>{error}</div>}

      {!loading && !error && Object.keys(pacing).length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', padding: '14px 16px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
          No pacing config found — set start/end dates and monthly budgets on the Spend Sheet tab first. Underspend is computed from that.
        </div>
      )}
      {!loading && !error && Object.keys(pacing).length > 0 && shortfalls.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--green-dark, #15803d)', padding: '14px 16px', background: 'var(--green-light, rgba(34,197,94,0.08))', border: '1px solid var(--green, #16a34a)', borderRadius: 10 }}>
          ✓ Every configured state is pacing at or above its needed daily spend — nothing to fill.
        </div>
      )}

      {recommendations.map(rec => (
        <div key={rec.group} style={{ marginBottom: 30 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{rec.group}</div>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#dc2626' }}>underspending {fmt(rec.shortfall)}/day</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              needs {fmt(rec.dailyNeeded)}/day · live {fmt(rec.liveBudget)}/day · {fmt(rec.remaining)} left over {rec.daysLeft.toFixed(1)} days
            </span>
          </div>
          {rec.candidates.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '10px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}>
              No candidates clear the bar (≥{minLeads} leads{rec.brand !== 'LSS' ? `, ${rec.brand} campaigns only` : ''}). Try lowering min leads or the dormancy threshold.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ ...th, width: 30 }}>#</th>
                    <th style={{ ...thL, width: 90 }}>Type</th>
                    <th style={thL}>Ad</th>
                    <th style={thL} title="When this ad last ran in this state, and how many leads it got here. 'Never – 0' = never run in this state.">Last used ({rec.state})</th>
                    <th style={th} title="Leads across ALL states for this client">Leads ttl</th>
                    <th style={th} title={`CPL in ${rec.state} only`}>CPL here</th>
                    <th style={th} title="CPL across all states">CPL ttl</th>
                    <th style={th}>Cases</th>
                    <th style={thL} title="Other states where this ad produced leads">Proven in</th>
                    <th style={thL}>Live now in</th>
                    <th style={{ ...th, width: 90 }}>Score</th>
                  </tr>
                </thead>
                <tbody>
                  {rec.candidates.map((c, i) => (
                    <tr key={c.name} style={{ background: i % 2 ? 'var(--bg)' : 'transparent' }}>
                      <td style={{ ...td, color: 'var(--text-muted)' }}>{i + 1}</td>
                      <td style={tdL}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10, letterSpacing: '0.05em',
                          background: c.tier === 1 ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.12)',
                          color: c.tier === 1 ? '#15803d' : '#1d4ed8',
                          border: `1px solid ${c.tier === 1 ? '#16a34a' : '#3b82f6'}` }}>
                          {c.tier === 1 ? 'NEW' : 'RELAUNCH'}
                        </span>
                      </td>
                      <td style={{ ...tdL, fontWeight: 600, color: 'var(--text)', minWidth: 220 }}>{c.name}</td>
                      {/* Last used in this state: "Never – 0" or "09/01 – 12" (date – leads here) */}
                      <td style={{ ...tdL, fontVariantNumeric: 'tabular-nums' }} title={c.lastUsedHere ? `Last ran in ${rec.state} on ${new Date(c.lastUsedHere).toLocaleDateString('en-US')} · ${c.hereLeads} leads here` : `Never run in ${rec.state}`}>
                        {c.usedHere
                          ? <span style={{ color: '#1d4ed8', fontWeight: 600 }}>{c.lastUsedHere ? new Date(c.lastUsedHere).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' }) : '?'} – {c.hereLeads}</span>
                          : <span style={{ color: '#15803d', fontWeight: 600 }}>Never – 0</span>}
                      </td>
                      <td style={{ ...td, fontWeight: 700 }}>{c.totalLeads}</td>
                      <td style={{ ...td, color: c.hereCpl == null ? 'var(--text-muted)' : c.hereCpl <= 300 ? '#15803d' : c.hereCpl <= 450 ? 'var(--text)' : '#dc2626' }}>
                        {c.hereCpl == null ? '—' : fmt(c.hereCpl)}
                      </td>
                      <td style={{ ...td, color: c.totalCpl == null ? 'var(--text-muted)' : c.totalCpl <= 300 ? '#15803d' : c.totalCpl <= 450 ? 'var(--text)' : '#dc2626' }}>
                        {c.totalCpl == null ? '—' : fmt(c.totalCpl)}
                      </td>
                      <td style={td}>{c.cases || ''}</td>
                      <td style={{ ...tdL, fontSize: 11, color: 'var(--text-muted)', maxWidth: 240 }}>
                        {(c.provenIn || []).slice(0, 5).map(p => `${p.st} ${p.leads}`).join(' · ')}
                      </td>
                      <td style={{ ...tdL, fontSize: 11, color: 'var(--text-muted)' }}>{(c.activeNow || []).join(', ')}</td>
                      <td style={td}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 48, height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.round(c.score * 100)}%`, height: '100%', background: 'var(--green, #16a34a)' }} />
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{Math.round(c.score * 100)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {!loading && recommendations.length > 0 && allAds.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Tip: run a sync on the Ads Tracking tab first — this tab reuses its stored ad data.
        </div>
      )}
    </div>
  );
}
