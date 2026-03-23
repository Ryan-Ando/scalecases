import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import { dbGetAll, dbUpsert, dbGetMeta, dbSetMeta } from './db.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);
function extractState(name) {
  if (!name) return null;
  const tokens = name.trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (US_STATES.has(tokens[i].toUpperCase())) return tokens[i].toUpperCase();
  }
  return null;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function daysAgo(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }

const PRESETS = [
  { label: 'Today', start: () => todayStr(), end: () => todayStr() },
  { label: '7d',    start: () => daysAgo(7),  end: () => todayStr() },
  { label: '14d',   start: () => daysAgo(14), end: () => todayStr() },
  { label: '30d',   start: () => daysAgo(30), end: () => todayStr() },
  { label: '90d',   start: () => daysAgo(90), end: () => todayStr() },
];

function fmt$(v)   { return v != null && v !== '' && !isNaN(parseFloat(v)) ? `$${parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; }
function fmtN(v)   { return v != null && v !== '' && !isNaN(parseFloat(v)) ? parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'; }
function fmtPct(v) { return v != null && v !== '' && !isNaN(parseFloat(v)) ? `${parseFloat(v).toFixed(2)}%` : '—'; }

function fmtBudget(item) {
  const db = parseFloat(item.dailyBudget);
  if (!isNaN(db) && db > 0) return `$${(db / 100).toFixed(0)}/day`;
  const lb = parseFloat(item.lifetimeBudget);
  if (!isNaN(lb) && lb > 0) return `$${(lb / 100).toFixed(0)} ltm`;
  return '—';
}

function fmtVideo(arr) {
  if (!Array.isArray(arr)) return '—';
  const v = arr.find(a => a.action_type === 'video_view');
  if (!v || !parseFloat(v.value)) return '—';
  const s = parseFloat(v.value);
  return s >= 60
    ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
    : `${s.toFixed(1)}s`;
}

function videoSecs(arr) {
  if (!Array.isArray(arr)) return 0;
  const v = arr.find(a => a.action_type === 'video_view');
  return v ? parseFloat(v.value) || 0 : 0;
}

// cost_per_result from FB is sometimes an array [{indicator,values:[{value}]}], not a scalar
function parseCprClient(raw) {
  if (!raw) return null;
  if (!Array.isArray(raw)) {
    const v = parseFloat(raw);
    return (!isNaN(v) && v > 0) ? raw : null;
  }
  if (raw.length > 0) {
    const v = parseFloat(raw[0]?.values?.[0]?.value ?? raw[0]?.value);
    return (!isNaN(v) && v > 0) ? v.toFixed(2) : null;
  }
  return null;
}

// Client-side CPL/CPC fallbacks — computed from available fields when server value is absent
function clientCpl(row) {
  const fromFb = parseCprClient(row.cost_per_result);
  if (fromFb) return fromFb;
  const spend = parseFloat(row.spend);
  const results = row.results;
  if (results > 0 && spend > 0) return (spend / results).toFixed(2);
  return null;
}
function clientCpc(row) {
  if (row.cost_per_unique_click) return row.cost_per_unique_click;
  const spend = parseFloat(row.spend);
  const clicks = parseFloat(row.unique_clicks);
  if (clicks > 0 && spend > 0) return (spend / clicks).toFixed(2);
  return null;
}

// Compute structured all-time / last-7d / last-3d stats for the popup chart + table
function computeAdStats(_, dailyRows) {
  const rows = [...dailyRows].sort((a, b) => a.date_start < b.date_start ? -1 : 1);
  if (!rows.length) return null;
  const cutoff7 = daysAgo(7);
  const cutoff3 = daysAgo(3);
  const LEAD_TYPES = ['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead','contact','schedule','submit_application'];
  function getLeads(r) {
    for (const t of LEAD_TYPES) {
      const a = (r.actions || []).find(x => x.action_type === t);
      if (a) return parseInt(a.value, 10) || 0;
    }
    return 0;
  }
  function sumPeriod(subset) {
    const spend       = subset.reduce((s, r) => s + (parseFloat(r.spend) || 0), 0);
    const leads       = subset.reduce((s, r) => s + getLeads(r), 0);
    const impressions = subset.reduce((s, r) => s + (parseFloat(r.impressions) || 0), 0);
    const clicks      = subset.reduce((s, r) => s + (parseFloat(r.unique_inline_link_clicks ?? r.unique_clicks) || 0), 0);
    const days        = subset.length;
    return {
      spend, leads, impressions, clicks, days,
      spendPerDay:      days > 0 ? spend / days : 0,
      leadsPerDay:      days > 0 ? leads / days : 0,
      impressionsPerDay:days > 0 ? impressions / days : 0,
      clicksPerDay:     days > 0 ? clicks / days : 0,
      cpl: leads > 0 ? spend / leads : null,
      cpc: clicks > 0 ? spend / clicks : null,
      cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
    };
  }
  const chartData = rows.map(r => ({
    date:        r.date_start.slice(5),
    spend:       parseFloat(r.spend) || 0,
    leads:       getLeads(r),
    impressions: parseFloat(r.impressions) || 0,
    clicks:      parseFloat(r.unique_inline_link_clicks ?? r.unique_clicks) || 0,
  }));
  return {
    all:    sumPeriod(rows),
    last7:  sumPeriod(rows.filter(r => r.date_start >= cutoff7)),
    last3:  sumPeriod(rows.filter(r => r.date_start >= cutoff3)),
    chartData,
  };
}

// Module-level so React sees a stable component reference across renders
function PctTag({ val, invert = false }) {
  if (val == null) return <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>—</span>;
  const n = parseFloat(val);
  const bad = invert ? n < 0 : n > 0;
  return (
    <span style={{ fontSize: 10, color: bad ? '#dc2626' : '#16a34a', marginLeft: 4 }}>
      {n > 0 ? '+' : ''}{val}%
    </span>
  );
}

function pctChange(recent, base) {
  if (base == null || base === 0) return null;
  return ((recent - base) / Math.abs(base) * 100).toFixed(0);
}

const TREND_LABEL = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 };
const TREND_TH = { textAlign: 'right', padding: '4px 8px', borderBottom: '1px solid var(--border)',
  fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' };
const TREND_TD = { textAlign: 'right', padding: '5px 8px', borderBottom: '1px solid var(--border)', fontSize: 12 };

// Pure rendering component — data is fetched by parent and passed in
function AdTrendSection({ rows, loading, error }) {
  const stats = useMemo(() => (rows?.length ? computeAdStats(null, rows) : null), [rows]);

  if (loading) return (
    <div style={{ padding: '12px 0 16px', color: 'var(--text-muted)', fontSize: 12 }}>Loading trend data…</div>
  );
  if (error) return (
    <div style={{ padding: '12px 0 16px', color: '#dc2626', fontSize: 12 }}>Trend error: {error}</div>
  );
  if (!stats) return (
    <div style={{ padding: '12px 0 16px', color: 'var(--text-muted)', fontSize: 12 }}>
      No historical data available for this ad.
    </div>
  );

  const { all, last7, last3, chartData } = stats;

  const METRICS = [
    { key: 'spendPerDay',       label: 'Spend/day',   fmt: v => fmt$(v),                invert: false },
    { key: 'leadsPerDay',       label: 'Leads/day',   fmt: v => v.toFixed(2),           invert: true  },
    { key: 'cpl',               label: 'CPL',         fmt: v => v ? fmt$(v) : '—',      invert: false },
    { key: 'cpc',               label: 'CPC',         fmt: v => v ? fmt$(v) : '—',      invert: false },
    { key: 'cpm',               label: 'CPM',         fmt: v => v ? fmt$(v) : '—',      invert: false },
    { key: 'ctr',               label: 'CTR',         fmt: v => v ? `${v.toFixed(2)}%` : '—', invert: true },
    { key: 'impressionsPerDay', label: 'Impressions/day', fmt: v => fmtN(v),            invert: true  },
    { key: 'clicksPerDay',      label: 'Clicks/day',  fmt: v => v.toFixed(2),           invert: true  },
  ];

  return (
    <>
      {/* Daily chart */}
      <div style={{ marginBottom: 18 }}>
        <div style={TREND_LABEL}>Daily Performance (all-time)</div>
        <LineChart width={580} height={140} data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} tickLine={false} interval="preserveStartEnd" />
          <YAxis yAxisId="l" orientation="left" tick={{ fontSize: 9 }} tickLine={false} width={42}
            tickFormatter={v => `$${v}`} />
          <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 9 }} tickLine={false} width={20} />
          <Tooltip formatter={(v, n) => [n === 'Spend' ? `$${parseFloat(v).toFixed(2)}` : v, n]}
            contentStyle={{ fontSize: 11 }} />
          <Line yAxisId="l" type="linear" dataKey="spend" stroke="#6366f1" dot={false}
            strokeWidth={1.5} name="Spend" />
          <Line yAxisId="r" type="linear" dataKey="leads" stroke="#10b981" dot={false}
            strokeWidth={1.5} name="Leads" />
        </LineChart>
      </div>

      {/* Stats comparison table */}
      <div style={{ marginBottom: 12 }}>
        <div style={TREND_LABEL}>Performance Trend</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...TREND_TH, textAlign: 'left' }}>Metric</th>
              <th style={TREND_TH}>All-time avg/day</th>
              <th style={TREND_TH}>Last 7d</th>
              <th style={TREND_TH}>Last 3d</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map(({ key, label, fmt, invert }, i) => {
              const isLast = i === METRICS.length - 1;
              const td = isLast ? { ...TREND_TD, borderBottom: 'none' } : TREND_TD;
              return (
                <tr key={key}>
                  <td style={{ ...td, textAlign: 'left' }}>{label}</td>
                  <td style={td}>{fmt(all[key] ?? 0)}</td>
                  <td style={td}>{fmt(last7[key] ?? 0)}<PctTag val={pctChange(last7[key], all[key])} invert={invert} /></td>
                  <td style={td}>{fmt(last3[key] ?? 0)}<PctTag val={pctChange(last3[key], all[key])} invert={invert} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, textAlign: 'right' }}>
          {all.days} days of data · % Δ vs all-time avg/day
        </div>
      </div>
    </>
  );
}

// Compute all-time / last-7d / last-3d trend summary for a single ad from daily rows
function computeAdTrend(adId, dailyRows) {
  const rows = dailyRows.filter(r => r.ad_id === adId);
  if (!rows.length) return null;
  const cutoff7 = daysAgo(7);
  const cutoff3 = daysAgo(3);
  const LEAD_TYPES = ['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead','contact','schedule','submit_application'];
  function sumPeriod(subset) {
    let spend = 0, leads = 0;
    for (const r of subset) {
      spend += parseFloat(r.spend) || 0;
      for (const t of LEAD_TYPES) {
        const a = (r.actions || []).find(x => x.action_type === t);
        if (a) { leads += parseInt(a.value, 10) || 0; break; }
      }
    }
    const cpl = leads > 0 ? (spend / leads).toFixed(2) : null;
    return { spend: spend.toFixed(2), leads, cpl };
  }
  const fmtP = p => `spend $${p.spend} | leads ${p.leads} | CPL ${p.cpl ? '$' + p.cpl : 'N/A'}`;
  const all   = sumPeriod(rows);
  const last7 = sumPeriod(rows.filter(r => r.date_start >= cutoff7));
  const last3 = sumPeriod(rows.filter(r => r.date_start >= cutoff3));
  return `All-time: ${fmtP(all)}\nLast 7d:  ${fmtP(last7)}\nLast 3d:  ${fmtP(last3)}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function deliveryOrder(r) {
  const s = r.effectiveStatus || r.status || '';
  if (s === 'ACTIVE') return 0;
  if (s === 'PAUSED') return 1;
  return 2;
}

// ── Badges ────────────────────────────────────────────────────────────────────
function DeliveryBadge({ status }) {
  const map = {
    ACTIVE:          { label: 'Active',          color: '#16a34a', bg: '#f0fdf4' },
    PAUSED:          { label: 'Paused',           color: '#64748b', bg: '#f1f5f9' },
    CAMPAIGN_PAUSED: { label: 'Campaign paused',  color: '#f59e0b', bg: '#fffbeb' },
    ADSET_PAUSED:    { label: 'Ad set paused',    color: '#f59e0b', bg: '#fffbeb' },
    ARCHIVED:        { label: 'Archived',         color: '#94a3b8', bg: '#f8fafc' },
    IN_PROCESS:      { label: 'In review',        color: '#3b82f6', bg: '#eff6ff' },
    WITH_ISSUES:     { label: 'Issues',           color: '#dc2626', bg: '#fef2f2' },
  };
  const s = map[status] || { label: status || '—', color: '#94a3b8', bg: '#f8fafc' };
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20,
      color: s.color, background: s.bg, border: `1px solid ${s.color}33`, whiteSpace: 'nowrap' }}>
      {s.label}
    </span>
  );
}

const RATING_MAP = {
  good:           ['Good',            '#16a34a', '#f0fdf4'],
  leave_on:       ['Leave On',        '#2563eb', '#eff6ff'],
  needs_attention:['Needs Attention',  '#f59e0b', '#fffbeb'],
  underperforming:['Underperforming',  '#ea580c', '#fff7ed'],
  turn_off:       ['Turn Off',         '#dc2626', '#fef2f2'],
  wait:           ['Wait',             '#64748b', '#f1f5f9'],
};

function RatingBadge({ rating }) {
  if (!rating) return null;
  const [label, color, bg] = RATING_MAP[rating] || ['Unknown', '#94a3b8', '#f8fafc'];
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
      color, background: bg, border: `1px solid ${color}44` }}>{label}</span>
  );
}

function ratingColors(rating) {
  const entry = RATING_MAP[rating];
  if (entry) return { border: entry[1], bg: entry[2] };
  return { border: 'var(--border)', bg: 'var(--surface)' };
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function campaignSummaryRating(adsets, rowAnalyses) {
  const order = { turn_off: 0, underperforming: 1, needs_attention: 2, leave_on: 3, good: 4, wait: 5 };
  let worst = null;
  for (const a of adsets) {
    const r = rowAnalyses[a.id];
    if (r?.rating && !r.loading && !r.error) {
      if (worst === null || (order[r.rating] ?? 99) < (order[worst] ?? 99)) worst = r.rating;
    }
  }
  return worst;
}

function isActive(r) { return (r.effectiveStatus || r.status) === 'ACTIVE'; }

function sortRows(rows, sortKey, sortDir) {
  const arr = [...rows];
  if (sortKey === '_default') {
    return arr.sort((a, b) => {
      const d = deliveryOrder(a) - deliveryOrder(b);
      if (d !== 0) return d;
      const ra = { good: 0, leave_on: 1, needs_attention: 2, underperforming: 3, turn_off: 4, wait: 5 }[a.rating] ?? 6;
      const rb = { good: 0, leave_on: 1, needs_attention: 2, underperforming: 3, turn_off: 4, wait: 5 }[b.rating] ?? 6;
      return ra - rb;
    });
  }
  return arr.sort((a, b) => {
    const av = getSortVal(a, sortKey), bv = getSortVal(b, sortKey);
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
}

// ── KPI Modal (per-campaign) ──────────────────────────────────────────────────
const KPI_FIELDS = [
  { key: 'targetCpl',      label: 'Target CPL — Cost per Lead ($)',               ph: 'e.g. 80',   dataKey: 'cost_per_result' },
  { key: 'targetCpc',      label: 'Target CPC — Cost per Unique Click ($)',        ph: 'e.g. 5',    dataKey: 'cost_per_unique_click' },
  { key: 'targetCpm',      label: 'Target CPM — Cost per 1,000 Impressions ($)',  ph: 'e.g. 15',   dataKey: 'cpm' },
  { key: 'targetCtr',      label: 'Target Unique CTR (%)',                         ph: 'e.g. 2.5',  dataKey: 'unique_ctr' },
  { key: 'maxFrequency',   label: 'Max Frequency (times seen)',                    ph: 'e.g. 3',    dataKey: 'frequency' },
  { key: 'targetSpend',    label: 'Target Daily Spend ($)',                        ph: 'e.g. 500',  dataKey: null },
  { key: 'minLeads',       label: 'Min Leads per Day',                             ph: 'e.g. 2',    dataKey: null },
  { key: 'minVideoTime',   label: 'Min Video Avg Play Time (seconds)',             ph: 'e.g. 10',   dataKey: null },
];

function KpiModal({ campaignId, campaignName, currentKpis, onSave, onClose }) {
  const [draft, setDraft]               = useState({ ...currentKpis });
  const [loadingDef, setLoadingDef]     = useState(false);
  const [defaultsNote, setDefaultsNote] = useState('');

  function set(k, v) { setDraft(d => ({ ...d, [k]: v })); }

  // Auto-fetch lifetime averages if this campaign has no saved KPIs yet
  useEffect(() => {
    const hasAny = KPI_FIELDS.some(f => currentKpis?.[f.key]);
    if (hasAny) return; // already configured
    setLoadingDef(true);
    fetch(`${BASE}/api/facebook/campaign-insights?campaign_id=${campaignId}`)
      .then(r => r.json())
      .then(data => {
        setDraft(prev => {
          const next = { ...prev };
          for (const f of KPI_FIELDS) {
            if (f.dataKey && data[f.dataKey] != null && !next[f.key]) {
              next[f.key] = parseFloat(data[f.dataKey]).toFixed(2);
            }
          }
          return next;
        });
        setDefaultsNote('Pre-filled with all-time averages — adjust as needed.');
      })
      .catch(() => {})
      .finally(() => setLoadingDef(false));
  }, []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: 'var(--surface)', borderRadius: 14, padding: 28, width: 440,
        maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 2 }}>KPIs — {campaignName}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: defaultsNote ? 6 : 16 }}>
          Targets are used by AI to rate performance and flag issues.
        </div>
        {loadingDef && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>Loading all-time averages…</div>
        )}
        {defaultsNote && !loadingDef && (
          <div style={{ fontSize: 12, color: '#16a34a', marginBottom: 14, background: '#f0fdf4',
            border: '1px solid #bbf7d0', borderRadius: 8, padding: '6px 10px' }}>{defaultsNote}</div>
        )}
        {KPI_FIELDS.map(({ key, label, ph }) => (
          <div key={key} style={{ marginBottom: 12 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
              color: 'var(--text-muted)', marginBottom: 4 }}>{label}</label>
            <input
              type="number" step="any" placeholder={ph}
              value={draft[key] || ''}
              onChange={e => set(key, e.target.value)}
              style={{ width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
                border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                boxSizing: 'border-box' }}
            />
          </div>
        ))}
        <div style={{ marginBottom: 18 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
            color: 'var(--text-muted)', marginBottom: 4 }}>Additional context for AI</label>
          <textarea
            placeholder="e.g. AZ historically has higher CPL in Q1, target market is seniors…"
            value={draft.notes || ''}
            onChange={e => set('notes', e.target.value)}
            rows={3}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 8, fontSize: 13,
              border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
              resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn--sm" onClick={onClose}>Cancel</button>
          <button className="btn btn--sm" style={{ background: 'var(--green)', color: '#fff' }}
            onClick={() => { onSave(campaignId, draft); onClose(); }}>Save KPIs</button>
        </div>
      </div>
    </div>
  );
}

// ── Stat box ──────────────────────────────────────────────────────────────────
function StatBox({ label, value }) {
  return (
    <div style={{ minWidth: 80 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
    </div>
  );
}

// ── Column definitions ────────────────────────────────────────────────────────
const COLS = [
  { key: 'name',                  label: 'Name',        align: 'left',  sticky: true },
  { key: 'status',                label: 'On/Off',      align: 'center' },
  { key: 'effectiveStatus',       label: 'Delivery',    align: 'center' },
  { key: 'aiStatus',              label: 'AI Review',   align: 'center' },
  { key: 'budget',                label: 'Budget',      align: 'right'  },
  { key: 'spend',                 label: 'Spent',       align: 'right'  },
  { key: 'results',               label: 'Results',     align: 'right'  },
  { key: 'cost_per_result',       label: 'CPL',         align: 'right'  },
  { key: 'unique_clicks',         label: 'Uniq Clicks', align: 'right'  },
  { key: 'cost_per_unique_click', label: 'CPC',         align: 'right'  },
  { key: 'frequency',             label: 'Frequency',   align: 'right'  },
  { key: 'cpm',                   label: 'CPM',         align: 'right'  },
  { key: 'unique_ctr',            label: 'Uniq CTR',    align: 'right'  },
  { key: 'videoTime',             label: 'Video Time',  align: 'right'  },
  { key: 'createdTime',           label: 'Created',     align: 'right'  },
];

function getSortVal(r, key) {
  switch (key) {
    case 'name':                  return (r.name || '').toLowerCase();
    case 'status':
    case 'effectiveStatus':       return deliveryOrder(r);
    case 'budget':                return parseFloat(r.dailyBudget || r.lifetimeBudget || 0) / 100;
    case 'spend':                 return parseFloat(r.spend || 0);
    case 'results':               return r.results || 0;
    case 'cost_per_result':       return parseFloat(clientCpl(r) || 0) || 1e9;
    case 'unique_clicks':         return parseFloat(r.unique_clicks || 0);
    case 'cost_per_unique_click': return parseFloat(clientCpc(r) || 0) || 1e9;
    case 'frequency':             return parseFloat(r.frequency || 0);
    case 'cpm':                   return parseFloat(r.cpm || 0);
    case 'unique_ctr':            return parseFloat(r.unique_ctr || 0);
    case 'videoTime':             return videoSecs(r.video_avg_time_watched_actions);
    case 'createdTime':           return r.createdTime || r.created_time || '';
    default:                      return 0;
  }
}

function cellVal(r, key) {
  switch (key) {
    case 'name':                  return <span style={{ fontWeight: 600 }} title={r.name}>{r.name}</span>;
    case 'status':                return <DeliveryBadge status={r.status} />;
    case 'effectiveStatus':       return <DeliveryBadge status={r.effectiveStatus || r.status} />;
    case 'budget':                return fmtBudget(r);
    case 'spend':                 return fmt$(r.spend);
    case 'results':               return r.results ?? '—';
    case 'cost_per_result':       return fmt$(clientCpl(r));
    case 'unique_clicks':         return fmtN(r.unique_clicks);
    case 'cost_per_unique_click': return fmt$(clientCpc(r));
    case 'frequency':             return fmtN(r.frequency);
    case 'cpm':                   return fmt$(r.cpm);
    case 'unique_ctr':            return fmtPct(r.unique_ctr);
    case 'videoTime':             return fmtVideo(r.video_avg_time_watched_actions);
    case 'createdTime':           return fmtDate(r.createdTime || r.created_time);
    default:                      return '—';
  }
}

// ── AI Rules Modal ────────────────────────────────────────────────────────────
function AiRulesModal({ campaigns, onClose }) {
  const [activeTab, setActiveTab] = useState('global');
  const [rules, setRules]         = useState({});
  const [savedTab, setSavedTab]   = useState(null);

  // Load all rules on open
  useEffect(() => {
    async function load() {
      const global = await dbGetMeta('aiRules_global').catch(() => '') || '';
      const map    = { global };
      for (const c of campaigns) {
        map[c.id] = await dbGetMeta(`aiRules_${c.id}`).catch(() => '') || '';
      }
      setRules(map);
    }
    load();
  }, []);

  async function save(key) {
    await dbSetMeta(`aiRules_${key}`, rules[key] || '');
    setSavedTab(key);
    setTimeout(() => setSavedTab(k => k === key ? null : k), 2000);
  }

  const tabCampaign = activeTab !== 'global' ? campaigns.find(c => c.id === activeTab) : null;
  const tabLabel    = activeTab === 'global' ? 'All Campaigns (Global)' : (tabCampaign?.name || '');
  const tabPlaceholder = activeTab === 'global'
    ? `Rules that apply to every campaign analysis.\n\nExamples:\n- Flag if CPL exceeds $100\n- AZ campaigns historically have higher CPL in winter\n- Frequency above 3.5 is a red flag — refresh creative\n- We prioritise lead quality over volume\n- A CPM over $20 usually means audience saturation`
    : `Rules specific to this campaign.\n\nExamples:\n- Target CPL for this state is $80–120\n- This campaign targets personal injury cases\n- Best performing creatives here use testimonials\n- Historically this campaign underperforms in December`;

  const sidebarBtn = (key, label, sub) => (
    <button key={key} onClick={() => setActiveTab(key)}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '9px 14px', border: 'none', borderRadius: 0,
        background: activeTab === key ? 'var(--green-light)' : 'transparent',
        borderLeft: activeTab === key ? '3px solid var(--green)' : '3px solid transparent',
        cursor: 'pointer', fontSize: 13, fontWeight: activeTab === key ? 700 : 400,
        color: activeTab === key ? 'var(--green-dark)' : 'var(--text)',
      }}>
      {label}
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginTop: 1 }}>{sub}</div>}
    </button>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: 'var(--surface)', borderRadius: 14, width: 720, maxHeight: '88vh',
        display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,0.22)', overflow: 'hidden' }}
        onClick={e => e.stopPropagation()}>

        {/* Modal header */}
        <div style={{ padding: '18px 22px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>🧠</span>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>AI Rules</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Standing instructions the AI follows in every analysis. Global rules apply to all campaigns; campaign tabs let you add campaign-specific context.
            </div>
          </div>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none',
            fontSize: 18, cursor: 'pointer', color: 'var(--text-muted)', padding: '0 4px' }}>✕</button>
        </div>

        {/* Body: sidebar + editor */}
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

          {/* Sidebar */}
          <div style={{ width: 210, borderRight: '1px solid var(--border)', overflowY: 'auto',
            background: 'var(--bg)', flexShrink: 0, paddingTop: 8 }}>
            {sidebarBtn('global', '🌐 All Campaigns', 'Global rules')}
            <div style={{ padding: '10px 14px 4px', fontSize: 10, fontWeight: 700,
              textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>
              Per Campaign
            </div>
            {campaigns.map(c => {
              const state = extractState(c.name);
              return sidebarBtn(c.id, state ? `${state} — ${c.name.slice(0, 22)}` : c.name.slice(0, 28), null);
            })}
          </div>

          {/* Editor */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 20, gap: 12, overflow: 'hidden' }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>{tabLabel}</div>
              {activeTab === 'global' && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  These rules are injected into the AI prompt for every campaign analysis.
                </div>
              )}
            </div>
            <textarea
              value={rules[activeTab] || ''}
              onChange={e => setRules(r => ({ ...r, [activeTab]: e.target.value }))}
              placeholder={tabPlaceholder}
              style={{ flex: 1, minHeight: 280, padding: '12px 14px', borderRadius: 10, fontSize: 13,
                border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
                resize: 'none', fontFamily: 'inherit', lineHeight: 1.6 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn--sm" onClick={onClose}>Close</button>
              <button className="btn btn--sm"
                style={{ background: 'var(--green)', color: '#fff', minWidth: 90 }}
                onClick={() => save(activeTab)}>
                {savedTab === activeTab ? '✓ Saved' : 'Save Rules'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Date Range Picker ─────────────────────────────────────────────────────────
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function DateRangePicker({ start, end, onChange }) {
  const [open, setOpen]       = useState(false);
  const [picking, setPicking] = useState(null); // first click sets this
  const [hover, setHover]     = useState(null);
  const [viewYear, setViewYear]   = useState(() => (start ? new Date(start + 'T12:00:00') : new Date()).getFullYear());
  const [viewMonth, setViewMonth] = useState(() => (start ? new Date(start + 'T12:00:00') : new Date()).getMonth());
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    function handle(e) { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); setPicking(null); } }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  function openPicker() {
    const d = start ? new Date(start + 'T12:00:00') : new Date();
    setViewYear(d.getFullYear()); setViewMonth(d.getMonth());
    setPicking(null); setHover(null); setOpen(true);
  }
  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }
  function handleDayClick(d) {
    if (d > todayStr()) return;
    if (!picking) {
      setPicking(d);
    } else {
      const s = d < picking ? d : picking;
      const e = d < picking ? picking : d;
      onChange({ start: s, end: e });
      setPicking(null); setHover(null); setOpen(false);
    }
  }

  // Build grid cells for current view month
  const firstDow = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }

  function getRangeInfo(d) {
    if (!d) return {};
    const today = todayStr();
    if (d > today) return { future: true };
    let rStart, rEnd;
    if (picking) {
      const h = hover || picking;
      rStart = picking <= h ? picking : h;
      rEnd   = picking <= h ? h : picking;
    } else {
      rStart = start; rEnd = end;
    }
    return {
      isStart: d === rStart,
      isEnd:   d === rEnd,
      inRange: rStart && rEnd && d > rStart && d < rEnd,
      isToday: d === today,
    };
  }

  const prompt = picking ? 'Click end date' : 'Click start date';

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className="btn btn--sm"
        onClick={() => open ? (setOpen(false), setPicking(null)) : openPicker()}
        style={{ fontSize: 12, fontFamily: 'monospace', letterSpacing: '-0.01em' }}>
        {start} – {end}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: '100%', marginTop: 6,
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
          padding: '14px 16px', zIndex: 300, boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          minWidth: 268 }}>
          <div style={{ fontSize: 11, color: picking ? '#16a34a' : 'var(--text-muted)',
            textAlign: 'center', marginBottom: 10, fontWeight: picking ? 700 : 400 }}>{prompt}</div>
          {/* Month nav */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, padding: '0 6px', color: 'var(--text)', lineHeight: 1 }}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{MONTH_NAMES[viewMonth]} {viewYear}</span>
            <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 18, padding: '0 6px', color: 'var(--text)', lineHeight: 1 }}>›</button>
          </div>
          {/* Day-of-week headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {['Su','Mo','Tu','We','Th','Fr','Sa'].map(h => (
              <div key={h} style={{ textAlign: 'center', fontSize: 10, fontWeight: 700,
                color: 'var(--text-muted)', padding: '2px 0' }}>{h}</div>
            ))}
          </div>
          {/* Day cells */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}
            onMouseLeave={() => setHover(null)}>
            {cells.map((d, i) => {
              const { future, isStart, isEnd, inRange, isToday } = getRangeInfo(d);
              let bg = 'transparent', color = 'var(--text)', outline = 'none';
              if (!d || future) { color = 'var(--text-muted)'; }
              if (inRange)        { bg = '#d1fae5'; }
              if (isStart || isEnd) { bg = '#16a34a'; color = '#fff'; }
              if (isToday && !isStart && !isEnd) { outline = '1px solid #16a34a'; }
              return (
                <div key={i}
                  onClick={d && !future ? () => handleDayClick(d) : undefined}
                  onMouseEnter={d && !future ? () => setHover(d) : undefined}
                  style={{
                    height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, borderRadius: 6, background: bg, color,
                    outline, cursor: d && !future ? 'pointer' : 'default',
                    opacity: future ? 0.35 : 1, userSelect: 'none',
                  }}>
                  {d ? new Date(d + 'T12:00:00').getDate() : ''}
                </div>
              );
            })}
          </div>
          {/* Current selection display */}
          {(picking || (start && end)) && (
            <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)',
              textAlign: 'center', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
              {picking
                ? <><strong style={{ color: 'var(--text)' }}>{picking}</strong> → pick end date</>
                : <><strong style={{ color: 'var(--text)' }}>{start}</strong> → <strong style={{ color: 'var(--text)' }}>{end}</strong></>
              }
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function CampaignReports() {
  const [dateRange, setDateRange] = useState({ start: daysAgo(7), end: todayStr() });
  const { start, end } = dateRange;
  const tfLabel = `${start} – ${end}`;

  const [kpisMap, setKpisMap]       = useState({});
  const [kpiModal, setKpiModal]     = useState(null);
  const [showRules, setShowRules]   = useState(false);

  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  // Accordion data
  const [allAdsets, setAllAdsets] = useState({});     // campaignId → adsets[]
  const [allAds, setAllAds]       = useState({});     // adsetId → ads[]

  // Refs to prevent duplicate in-flight fetches
  const _loadingAdsetIds = useRef(new Set());
  const _loadingAdIds    = useRef(new Set());

  // Persist expanded/paused state across refreshes and date changes
  const [expandedCampaigns, setExpandedCampaigns] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('sc_expandedCampaigns') || '[]')); } catch { return new Set(); }
  });
  const [expandedAdsets, setExpandedAdsets] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('sc_expandedAdsets') || '[]')); } catch { return new Set(); }
  });
  const [showPausedCampaigns, setShowPausedCampaigns] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sc_showPausedCampaigns') || 'false'); } catch { return false; }
  });
  const [showPausedAdsets, setShowPausedAdsets] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sc_showPausedAdsets') || '{}'); } catch { return {}; }
  });
  const [showPausedAds, setShowPausedAds] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sc_showPausedAds') || '{}'); } catch { return {}; }
  });

  useEffect(() => { localStorage.setItem('sc_expandedCampaigns',  JSON.stringify([...expandedCampaigns])); }, [expandedCampaigns]);
  useEffect(() => { localStorage.setItem('sc_expandedAdsets',     JSON.stringify([...expandedAdsets])); },   [expandedAdsets]);
  useEffect(() => { localStorage.setItem('sc_showPausedCampaigns',JSON.stringify(showPausedCampaigns)); },   [showPausedCampaigns]);
  useEffect(() => { localStorage.setItem('sc_showPausedAdsets',   JSON.stringify(showPausedAdsets)); },      [showPausedAdsets]);
  useEffect(() => { localStorage.setItem('sc_showPausedAds',      JSON.stringify(showPausedAds)); },         [showPausedAds]);
  const [sortKey, setSortKey] = useState('_default');
  const [sortDir, setSortDir] = useState('asc');

  // Popup state
  const [popup, setPopup]               = useState(null);
  const [adDailyCache, setAdDailyCache] = useState({});

  // API stats panel
  const [showApiStats, setShowApiStats]   = useState(false);
  const [apiStats, setApiStats]           = useState(null);
  const [apiStatsLoading, setApiStatsLoading] = useState(false);

  // Status toggles for adsets/ads
  const [statusOverrides, setStatusOverrides] = useState({});
  const [togglingIds, setTogglingIds]         = useState(new Set());

  // Campaign status toggles
  const [campaignStatusOverrides, setCampaignStatusOverrides] = useState({});
  const [togglingCampaigns, setTogglingCampaigns]             = useState(new Set());

  const [analyses, setAnalyses]             = useState({});
  const [rowAnalyses, setRowAnalyses]       = useState({});
  const [training, setTraining]             = useState({});
  const [noteInputs, setNoteInputs]         = useState({});
  const [adDailyInsights, setAdDailyInsights] = useState([]);

  // ── Persist: load KPIs + training from IndexedDB ──────────────────────────
  useEffect(() => {
    dbGetAll('campaignKpis').then(rows => {
      const map = {};
      for (const r of rows) map[r.id] = r;
      setKpisMap(map);
    }).catch(() => {});

    dbGetAll('campaignTraining').then(rows => {
      const map = {};
      for (const r of rows) {
        if (!map[r.campaignId]) map[r.campaignId] = [];
        map[r.campaignId].push(r);
      }
      for (const id of Object.keys(map)) map[id].sort((a, b) => b.ts - a.ts).splice(20);
      setTraining(map);
    }).catch(() => {});

    dbGetMeta('campaignAnalyses').then(saved => {
      if (saved && typeof saved === 'object') setAnalyses(saved);
    }).catch(() => {});

    dbGetMeta('rowAnalyses_all').then(saved => {
      if (saved && typeof saved === 'object') setRowAnalyses(saved);
    }).catch(() => {});

    dbGetAll('adDailyInsights').then(rows => {
      setAdDailyInsights(rows);
    }).catch(() => {});
  }, []);

  // ── Load campaigns only (lazy: adsets/ads fetched on expand) ─────────────
  async function loadAll() {
    setLoading(true); setError('');
    // Clear stale adset/ad data when date changes — they'll reload on expand
    setAllAdsets({});
    setAllAds({});
    _loadingAdsetIds.current.clear();
    _loadingAdIds.current.clear();
    try {
      const res  = await fetch(`${BASE}/api/facebook/campaigns?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setCampaigns(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  // ── Lazy-load adsets for one campaign on expand ───────────────────────────
  async function loadAdsets(campaignId) {
    if (allAdsets[campaignId] !== undefined) return; // already loaded
    if (_loadingAdsetIds.current.has(campaignId)) return; // in flight
    _loadingAdsetIds.current.add(campaignId);
    try {
      const res    = await fetch(`${BASE}/api/facebook/adsets?campaign_id=${campaignId}&start=${start}&end=${end}`);
      const adsets = await res.json();
      setAllAdsets(prev => ({ ...prev, [campaignId]: Array.isArray(adsets) ? adsets : [] }));
    } catch (e) {
      console.error('loadAdsets failed:', e);
      setAllAdsets(prev => ({ ...prev, [campaignId]: [] }));
    } finally {
      _loadingAdsetIds.current.delete(campaignId);
    }
  }

  // ── Lazy-load ads for one adset on expand ────────────────────────────────
  async function loadAds(adsetId) {
    if (allAds[adsetId] !== undefined) return; // already loaded
    if (_loadingAdIds.current.has(adsetId)) return; // in flight
    _loadingAdIds.current.add(adsetId);
    try {
      const res = await fetch(`${BASE}/api/facebook/ads?adset_id=${adsetId}&start=${start}&end=${end}`);
      const ads = await res.json();
      setAllAds(prev => ({ ...prev, [adsetId]: Array.isArray(ads) ? ads : [] }));
    } catch (e) {
      console.error('loadAds failed:', e);
      setAllAds(prev => ({ ...prev, [adsetId]: [] }));
    } finally {
      _loadingAdIds.current.delete(adsetId);
    }
  }

  useEffect(() => { loadAll(); }, [start, end]);

  async function fetchApiStats() {
    setApiStatsLoading(true);
    try {
      const res  = await fetch(`${BASE}/api/facebook/stats`);
      const data = await res.json();
      setApiStats(data);
    } catch { /* ignore */ } finally {
      setApiStatsLoading(false);
    }
  }

  // After campaigns load (or date changes), re-fetch adsets/ads for persisted open dropdowns
  useEffect(() => {
    if (campaigns.length === 0) return;
    for (const cid of expandedCampaigns) loadAdsets(cid);
  }, [campaigns]);

  useEffect(() => {
    const loadedAdsetIds = Object.values(allAdsets).flat().map(a => a.id);
    for (const aid of expandedAdsets) {
      if (loadedAdsetIds.includes(aid)) loadAds(aid);
    }
  }, [allAdsets]);

  // ── Fetch daily data when popup opens ─────────────────────────────────────
  useEffect(() => {
    if (!popup) return;
    if (adDailyCache[popup]) return;
    const allRows = [...Object.values(allAdsets).flat(), ...Object.values(allAds).flat()];
    const row = allRows.find(r => r.id === popup);
    if (!row) return;
    const isAdRow = Object.values(allAds).flat().some(a => a.id === popup);
    const idField = isAdRow ? 'ad_ids' : 'adset_ids';
    setAdDailyCache(prev => ({ ...prev, [popup]: { loading: true } }));
    fetch(`${BASE}/api/facebook/daily?date_preset=maximum&${idField}=${encodeURIComponent(popup)}`)
      .then(r => r.json())
      .then(data => setAdDailyCache(prev => ({ ...prev, [popup]: { rows: Array.isArray(data) ? data : [] } })))
      .catch(e => setAdDailyCache(prev => ({ ...prev, [popup]: { error: e.message, rows: [] } })));
  }, [popup]);

  // ── AI analysis ───────────────────────────────────────────────────────────
  async function analyze(campaign, adsetsForCampaign = []) {
    const id = campaign.id;
    setAnalyses(prev => ({ ...prev, [id]: { loading: true } }));
    const notes = (training[id] || []).slice(0, 8).map(n => ({ type: n.type, text: n.text }));
    const kpis  = kpisMap[id] || {};
    const [globalRules, campaignRules] = await Promise.all([
      dbGetMeta('aiRules_global').catch(() => ''),
      dbGetMeta(`aiRules_${id}`).catch(() => ''),
    ]);
    try {
      const res  = await fetch(`${BASE}/api/reports/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          campaign, adsets: adsetsForCampaign, kpis, trainingNotes: notes, timeframeLabel: tfLabel,
          globalRules: globalRules || '', campaignRules: campaignRules || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAnalyses(prev => {
        const next = { ...prev, [id]: data };
        dbSetMeta('campaignAnalyses', next).catch(() => {});
        return next;
      });
    } catch (e) {
      setAnalyses(prev => ({ ...prev, [id]: { error: e.message } }));
    }
  }

  // ── Row-level AI analysis (adset or ad) ──────────────────────────────────
  async function analyzeRow(row, level) {
    const id = row.id;
    setRowAnalyses(prev => ({ ...prev, [id]: { loading: true } }));
    const campaignId = row.campaignId || row.campaign_id;
    const kpis = campaignId ? (kpisMap[campaignId] || {}) : {};
    const [globalRules, campaignRules, storedDaily] = await Promise.all([
      dbGetMeta('aiRules_global').catch(() => ''),
      campaignId ? dbGetMeta(`aiRules_${campaignId}`).catch(() => '') : Promise.resolve(''),
      level === 'ad' ? dbGetAll('adDailyInsights').catch(() => []) : Promise.resolve([]),
    ]);
    let dailyRows = storedDaily;
    if (level === 'ad' && !dailyRows.some(r => r.ad_id === row.id)) {
      try {
        const d = await fetch(`${BASE}/api/facebook/daily?date_preset=maximum&ad_ids=${encodeURIComponent(row.id)}`).then(r => r.json());
        if (Array.isArray(d)) dailyRows = [...dailyRows, ...d];
      } catch {}
    }
    const enrichedRow = level === 'ad'
      ? { ...row, trendSummary: computeAdTrend(row.id, dailyRows) }
      : row;
    try {
      const res = await fetch(`${BASE}/api/reports/analyze-row`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          row: enrichedRow, level, kpis, timeframeLabel: tfLabel,
          globalRules: globalRules || '', campaignRules: campaignRules || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRowAnalyses(prev => {
        const next = { ...prev, [id]: data };
        dbSetMeta('rowAnalyses_all', next).catch(() => {});
        return next;
      });
    } catch (e) {
      setRowAnalyses(prev => ({ ...prev, [id]: { error: e.message } }));
    }
  }

  // ── Batch AI analysis — one API call for all rows ────────────────────────
  async function analyzeAllRows(rows, level, campaignId) {
    if (!rows.length) return;
    setRowAnalyses(prev => {
      const next = { ...prev };
      for (const r of rows) next[r.id] = { loading: true };
      return next;
    });
    const kpis = campaignId ? (kpisMap[campaignId] || {}) : {};
    const campaignRules = campaignId ? await dbGetMeta(`aiRules_${campaignId}`).catch(() => '') : '';
    const [globalRules, storedDaily] = await Promise.all([
      dbGetMeta('aiRules_global').catch(() => ''),
      level === 'ad' ? dbGetAll('adDailyInsights').catch(() => []) : Promise.resolve([]),
    ]);
    let dailyRows = storedDaily;
    if (level === 'ad') {
      const adIdsWithData = new Set(dailyRows.map(r => r.ad_id));
      const missing = rows.filter(r => !adIdsWithData.has(r.id)).map(r => r.id);
      if (missing.length) {
        try {
          const d = await fetch(`${BASE}/api/facebook/daily?date_preset=maximum&ad_ids=${encodeURIComponent(missing.join(','))}`).then(r => r.json());
          if (Array.isArray(d)) dailyRows = [...dailyRows, ...d];
        } catch {}
      }
    }
    const enrichedRows = level === 'ad'
      ? rows.map(r => ({ ...r, trendSummary: computeAdTrend(r.id, dailyRows) }))
      : rows;
    try {
      const res = await fetch(`${BASE}/api/reports/analyze-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: enrichedRows, level, kpis, timeframeLabel: tfLabel,
          globalRules: globalRules || '', campaignRules: campaignRules || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (!Array.isArray(data)) throw new Error('Unexpected response');
      setRowAnalyses(prev => {
        const next = { ...prev };
        for (const item of data) next[item.id] = item;
        dbSetMeta('rowAnalyses_all', next).catch(() => {});
        return next;
      });
    } catch (e) {
      setRowAnalyses(prev => {
        const next = { ...prev };
        for (const r of rows) { if (next[r.id]?.loading) next[r.id] = { error: e.message }; }
        return next;
      });
    }
  }

  // ── KPI save (to IndexedDB) ───────────────────────────────────────────────
  async function saveKpis(campaignId, next) {
    const entry = { id: campaignId, ...next };
    await dbUpsert('campaignKpis', [entry]);
    setKpisMap(prev => ({ ...prev, [campaignId]: entry }));
  }

  // ── Training ──────────────────────────────────────────────────────────────
  async function addTraining(campaignId, campaignName, type, text) {
    const entry = { id: `${campaignId}_${Date.now()}`, campaignId, campaignName, type, text, ts: Date.now() };
    await dbUpsert('campaignTraining', [entry]);
    setTraining(prev => ({ ...prev, [campaignId]: [entry, ...(prev[campaignId] || [])].slice(0, 20) }));
  }

  // ── Campaign status toggle ────────────────────────────────────────────────
  async function toggleCampaign(c) {
    const current = campaignStatusOverrides[c.id] || c.status;
    const next    = current === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
    const action  = next === 'PAUSED' ? 'Pause' : 'Enable';
    if (!window.confirm(`${action} campaign "${c.name}"?`)) return;
    setTogglingCampaigns(prev => new Set([...prev, c.id]));
    setCampaignStatusOverrides(prev => ({ ...prev, [c.id]: next }));
    try {
      const res  = await fetch(`${BASE}/api/facebook/campaign/${c.id}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
    } catch (e) {
      setCampaignStatusOverrides(prev => { const n = { ...prev }; delete n[c.id]; return n; });
      alert(`Failed: ${e.message}`);
    } finally {
      setTogglingCampaigns(prev => { const n = new Set(prev); n.delete(c.id); return n; });
    }
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function handleSort(key) {
    setSortKey(prev => {
      setSortDir(d => prev === key ? (d === 'asc' ? 'desc' : 'asc') : 'asc');
      return key;
    });
  }

  function sortIndicator(key) {
    if (sortKey === key) return <span style={{ marginLeft: 4, fontSize: 9 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>;
    return <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.3 }}>⇅</span>;
  }

  const thStyle = (col) => ({
    padding: '9px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '2px solid var(--border)',
    whiteSpace: 'nowrap', background: 'var(--surface)', position: 'sticky', top: 0,
    cursor: 'pointer', userSelect: 'none', textAlign: col.align || 'right',
    zIndex: col.key === 'name' ? 12 : 10,
    ...(col.key === 'name' ? { left: 36 } : {}),
  });

  const tdBase = {
    padding: '8px 12px', fontSize: 12, borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap', color: 'var(--text)', background: 'var(--surface)',
  };

  const pausedFooterStyle = {
    textAlign: 'center', padding: '6px', color: 'var(--text-muted)',
    fontSize: 12, background: 'var(--bg)',
  };

  // renderAiCell for adsets and ads
  function renderAiCell(r, level, campaignId) {
    const a = rowAnalyses[r.id];
    if (!a) return (
      <button className="btn btn--sm" style={{ fontSize: 10, padding: '2px 8px' }}
        onClick={e => { e.stopPropagation(); analyzeRow(r, level); setPopup(r.id); }}>Analyze</button>
    );
    if (a.loading) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>…</span>;
    if (a.error) return (
      <button className="btn btn--sm" style={{ fontSize: 10, color: '#dc2626' }}
        onClick={e => { e.stopPropagation(); analyzeRow(r, level); }}>Retry</button>
    );
    return (
      <div onClick={e => { e.stopPropagation(); setPopup(r.id); }} style={{ cursor: 'pointer', display: 'inline-block' }}>
        <RatingBadge rating={a.rating} />
      </div>
    );
  }

  // renderCampaignAiCell for campaign rows
  function renderCampaignAiCell(c) {
    const adsets = (allAdsets[c.id] || []).filter(isActive);
    const analyzed = adsets.filter(a => rowAnalyses[a.id] && !rowAnalyses[a.id].loading && !rowAnalyses[a.id].error);
    const anyLoading = adsets.some(a => rowAnalyses[a.id]?.loading);
    const worst = campaignSummaryRating(adsets, rowAnalyses);

    if (anyLoading) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Analyzing…</span>;

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {worst && <RatingBadge rating={worst} />}
        <button className="btn btn--sm" style={{ fontSize: 10 }}
          onClick={e => { e.stopPropagation(); analyzeAllRows(adsets, 'adset', c.id); }}>
          {analyzed.length > 0 ? `↺ ${analyzed.length}/${adsets.length}` : '✦ Analyze'}
        </button>
      </div>
    );
  }

  // renderStatusCell for adsets and ads
  function renderStatusCell(r, type) {
    const rawStatus = statusOverrides[r.id] || r.status;
    const isPaused  = rawStatus !== 'ACTIVE';
    const isToggling = togglingIds.has(r.id);
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button className="btn btn--sm" disabled={isToggling}
          onClick={async e => {
            e.stopPropagation();
            const current = statusOverrides[r.id] || r.status;
            const next = current === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
            const action = next === 'PAUSED' ? 'Pause' : 'Enable';
            if (!window.confirm(`${action} "${r.name}"?`)) return;
            setTogglingIds(prev => new Set([...prev, r.id]));
            setStatusOverrides(prev => ({ ...prev, [r.id]: next }));
            try {
              const res = await fetch(`${BASE}/api/facebook/${type}/${r.id}/status`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: next }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error);
            } catch (err) {
              setStatusOverrides(prev => { const n = {...prev}; delete n[r.id]; return n; });
              alert(`Failed: ${err.message}`);
            } finally {
              setTogglingIds(prev => { const n = new Set(prev); n.delete(r.id); return n; });
            }
          }}
          title={`${isPaused ? 'Enable' : 'Pause'} this ${type}`}
          style={{ fontSize: 10, padding: '1px 6px', minWidth: 22 }}>
          {isToggling ? '…' : isPaused ? '▶' : '⏸'}
        </button>
      </div>
    );
  }

  // Render a single campaign group (campaign row + adsets + ads)
  function renderCampaignGroup(c) {
    const adsets = allAdsets[c.id] || [];
    const activeAdsets = adsets.filter(isActive);
    const pausedAdsets = adsets.filter(a => !isActive(a));
    const isExpanded = expandedCampaigns.has(c.id);
    const worstRating = campaignSummaryRating(adsets, rowAnalyses);
    const { border: borderColor, bg: ratingBg } = ratingColors(worstRating);
    const hasKpis = KPI_FIELDS.some(f => kpisMap[c.id]?.[f.key]);

    const campStatus = campaignStatusOverrides[c.id] || c.status;
    const campIsPaused = campStatus !== 'ACTIVE';
    const campIsToggling = togglingCampaigns.has(c.id);

    // Campaign row cells in COLS order
    const campaignCellContent = (col) => {
      switch (col.key) {
        case 'name':
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700 }} title={c.name}>{c.name}</span>
              <button className="btn btn--sm"
                onClick={e => { e.stopPropagation(); setKpiModal({ campaignId: c.id, campaignName: c.name }); }}
                title={hasKpis ? 'Edit KPIs' : 'Set KPIs (no targets yet)'}
                style={{ fontSize: 10, color: hasKpis ? 'var(--green-dark)' : 'var(--text-muted)', padding: '1px 6px' }}>
                ⚙ KPI{hasKpis ? ' ✓' : ''}
              </button>
            </div>
          );
        case 'status':
          return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button className="btn btn--sm" disabled={campIsToggling}
                onClick={e => { e.stopPropagation(); toggleCampaign(c); }}
                title={campIsPaused ? 'Enable campaign' : 'Pause campaign'}
                style={{ fontSize: 10, padding: '1px 6px', minWidth: 22 }}>
                {campIsToggling ? '…' : campIsPaused ? '▶' : '⏸'}
              </button>
            </div>
          );
        case 'effectiveStatus':
          return <DeliveryBadge status={campaignStatusOverrides[c.id] || c.effectiveStatus || c.status} />;
        case 'aiStatus':
          return renderCampaignAiCell(c);
        case 'budget':
          return fmtBudget(c);
        case 'spend':
          return fmt$(c.spend);
        case 'results':
          return c.results ?? '—';
        case 'cost_per_result':
          return fmt$(clientCpl(c));
        case 'unique_clicks':
          return fmtN(c.unique_clicks);
        case 'cost_per_unique_click':
          return fmt$(clientCpc(c));
        case 'frequency':
          return fmtN(c.frequency);
        case 'cpm':
          return fmt$(c.cpm);
        case 'unique_ctr':
          return fmtPct(c.unique_ctr);
        case 'videoTime':
          return '—';
        case 'createdTime':
          return fmtDate(c.createdTime || c.created_time);
        default:
          return '—';
      }
    };

    const campRowBase = {
      background: ratingBg,
      padding: '10px 12px',
      fontSize: 14,
      fontWeight: 700,
      height: 52,
      whiteSpace: 'nowrap',
      borderTop: `1px solid ${borderColor}`,
      borderBottom: `1px solid ${borderColor}`,
    };

    return (
      <Fragment key={c.id}>
        {/* Campaign row */}
        <tr style={{ cursor: 'pointer' }} onClick={() => {
          setExpandedCampaigns(prev => {
            const next = new Set(prev);
            if (next.has(c.id)) { next.delete(c.id); } else { next.add(c.id); loadAdsets(c.id); }
            return next;
          });
        }}>
          {/* Chevron cell */}
          <td style={{
            ...campRowBase,
            width: 36,
            textAlign: 'center',
            borderLeft: `4px solid ${borderColor}`,
            borderRadius: '8px 0 0 8px',
            position: 'sticky', left: 0, zIndex: 3,
          }}>
            {isExpanded ? '▾' : '▸'}
          </td>
          {COLS.map((col, idx) => {
            const isLast = idx === COLS.length - 1;
            const extraStyle = isLast
              ? { borderRadius: '0 8px 8px 0', borderRight: `1px solid ${borderColor}` }
              : {};
            return (
              <td key={col.key} style={{
                ...campRowBase,
                textAlign: col.align || 'right',
                ...extraStyle,
                ...(col.sticky ? { position: 'sticky', left: 36, zIndex: 2 } : {}),
              }}>
                {campaignCellContent(col)}
              </td>
            );
          })}
        </tr>

        {/* Adset rows when expanded */}
        {isExpanded && (
          <>
            {allAdsets[c.id] === undefined && (
              <tr><td colSpan={COLS.length + 1} style={{ ...tdBase, paddingLeft: 52, color: 'var(--text-muted)', fontStyle: 'italic' }}>Loading adsets…</td></tr>
            )}
            {sortRows(activeAdsets, sortKey, sortDir).map(a => renderAdsetRow(a, c.id))}

            {/* Paused adsets footer */}
            {pausedAdsets.length > 0 && (
              <>
                <tr style={{ cursor: 'pointer' }} onClick={() => setShowPausedAdsets(prev => ({ ...prev, [c.id]: !prev[c.id] }))}>
                  <td colSpan={COLS.length + 1} style={pausedFooterStyle}>
                    {showPausedAdsets[c.id] ? '▾' : '▸'} {pausedAdsets.length} paused ad set{pausedAdsets.length !== 1 ? 's' : ''}
                  </td>
                </tr>
                {showPausedAdsets[c.id] && sortRows(pausedAdsets, sortKey, sortDir).map(a => renderAdsetRow(a, c.id))}
              </>
            )}
          </>
        )}
      </Fragment>
    );
  }

  function renderAdsetRow(a, campaignId) {
    const ads = allAds[a.id] || [];
    const activeAds = ads.filter(isActive);
    const pausedAds = ads.filter(ad => !isActive(ad));
    const isExpanded = expandedAdsets.has(a.id);

    return (
      <Fragment key={a.id}>
        <tr
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
          {/* Chevron cell */}
          <td style={{ ...tdBase, paddingLeft: 20, textAlign: 'center', width: 36, cursor: 'pointer', position: 'sticky', left: 0, zIndex: 2 }}
            onClick={() => {
              setExpandedAdsets(prev => {
                const next = new Set(prev);
                if (next.has(a.id)) { next.delete(a.id); } else { next.add(a.id); loadAds(a.id); }
                return next;
              });
            }}>
            {isExpanded ? '▾' : '▸'}
          </td>
          {COLS.map(col => (
            <td key={col.key} style={{
              ...tdBase, textAlign: col.align || 'right',
              ...(col.sticky ? { position: 'sticky', left: 36, zIndex: 1 } : {}),
            }}>
              {col.key === 'aiStatus' ? renderAiCell(a, 'adset', campaignId)
                : col.key === 'status' ? renderStatusCell(a, 'adset')
                : col.key === 'name' ? <span style={{ fontWeight: 600, paddingLeft: 4 }} title={a.name}>{a.name}</span>
                : cellVal(a, col.key)}
            </td>
          ))}
        </tr>

        {/* Ad rows when adset expanded */}
        {isExpanded && (
          <>
            {allAds[a.id] === undefined && (
              <tr><td colSpan={COLS.length + 1} style={{ ...tdBase, paddingLeft: 68, color: 'var(--text-muted)', fontStyle: 'italic' }}>Loading ads…</td></tr>
            )}
            {sortRows(activeAds, sortKey, sortDir).map(ad => renderAdRow(ad, campaignId))}

            {/* Paused ads footer */}
            {pausedAds.length > 0 && (
              <>
                <tr style={{ cursor: 'pointer' }} onClick={() => setShowPausedAds(prev => ({ ...prev, [a.id]: !prev[a.id] }))}>
                  <td colSpan={COLS.length + 1} style={pausedFooterStyle}>
                    {showPausedAds[a.id] ? '▾' : '▸'} {pausedAds.length} paused ad{pausedAds.length !== 1 ? 's' : ''}
                  </td>
                </tr>
                {showPausedAds[a.id] && sortRows(pausedAds, sortKey, sortDir).map(ad => renderAdRow(ad, campaignId))}
              </>
            )}
          </>
        )}
      </Fragment>
    );
  }

  function renderAdRow(ad, campaignId) {
    const adTdBase = {
      padding: '6px 12px', fontSize: 11, borderBottom: '1px solid #e2e8f0',
      whiteSpace: 'nowrap', color: '#64748b', background: '#f8fafc',
    };
    return (
      <tr key={ad.id}
        onMouseEnter={e => { e.currentTarget.style.background = '#f1f5f9'; }}
        onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
        {/* No chevron for ads */}
        <td style={{ ...adTdBase, paddingLeft: 36, width: 36, position: 'sticky', left: 0, zIndex: 2 }} />
        {COLS.map(col => (
          <td key={col.key} style={{
            ...adTdBase, textAlign: col.align || 'right',
            ...(col.sticky ? { position: 'sticky', left: 36, zIndex: 1, background: '#f8fafc' } : {}),
          }}>
            {col.key === 'aiStatus' ? renderAiCell(ad, 'ad', campaignId)
              : col.key === 'status' ? renderStatusCell(ad, 'ad')
              : col.key === 'name'
                ? <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span title={ad.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{ad.name}</span>
                    <button className="btn btn--sm"
                      onClick={e => { e.stopPropagation(); window.open(`${BASE}/api/facebook/ad/${ad.id}/preview`, '_blank'); }}
                      title="Preview ad creative"
                      style={{ fontSize: 10, padding: '1px 6px', flexShrink: 0 }}>👁 Preview</button>
                  </div>
              : cellVal(ad, col.key)}
          </td>
        ))}
      </tr>
    );
  }

  // ── Popup ─────────────────────────────────────────────────────────────────
  const popupRow = popup
    ? [...Object.values(allAdsets).flat(), ...Object.values(allAds).flat()].find(r => r.id === popup)
    : null;
  const popupAnalysis = popup ? rowAnalyses[popup] : null;
  const popupIsAd = popup ? Object.values(allAds).flat().some(a => a.id === popup) : false;
  const popupLevel = popupIsAd ? 'ad' : 'adset';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px 28px', minHeight: '100%', boxSizing: 'border-box' }}>

      {/* Modals */}
      {showRules && <AiRulesModal campaigns={campaigns} onClose={() => setShowRules(false)} />}

      {/* API Stats Modal */}
      {showApiStats && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShowApiStats(false)}>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 28, maxWidth: 680, width: '95%', maxHeight: '80vh', overflowY: 'auto' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>📊 FB API Usage</h3>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn--sm" onClick={fetchApiStats} disabled={apiStatsLoading}>
                  {apiStatsLoading ? 'Refreshing…' : 'Refresh'}
                </button>
                <button className="btn btn--sm" onClick={() => setShowApiStats(false)}>✕</button>
              </div>
            </div>

            {apiStatsLoading && !apiStats && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</p>}

            {apiStats && (() => {
              const uptimeMin = Math.round(apiStats.uptimeSeconds / 60);
              return (
                <>
                  {/* Summary pills */}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
                    {[
                      { label: 'API Calls', value: apiStats.callCount, warn: apiStats.callCount > 50 },
                      { label: 'Cache Hits', value: apiStats.cacheHits, color: 'var(--green)' },
                      { label: 'Errors', value: apiStats.errors, warn: apiStats.errors > 0 },
                      { label: 'Cached Keys', value: apiStats.cacheSize },
                      { label: 'Uptime', value: uptimeMin < 60 ? `${uptimeMin}m` : `${Math.floor(uptimeMin/60)}h ${uptimeMin%60}m` },
                    ].map(({ label, value, warn, color }) => (
                      <div key={label} style={{ background: 'var(--bg)', border: `1px solid ${warn ? '#dc2626' : 'var(--border)'}`, borderRadius: 8, padding: '8px 14px', textAlign: 'center', minWidth: 90 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, color: color || (warn ? '#dc2626' : 'var(--text)') }}>{value}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Rate limits per account */}
                  {Object.keys(apiStats.rateLimits).length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>Rate Limit Usage (0–100%)</div>
                      {Object.entries(apiStats.rateLimits).map(([acct, limits]) => (
                        <div key={acct} style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>{acct}</div>
                          {[
                            { label: 'Call Count', key: 'call_count' },
                            { label: 'Total Time', key: 'total_time' },
                            { label: 'CPU Time', key: 'total_cputime' },
                            { label: 'Acct Util', key: 'acc_id_util_pct' },
                            { label: 'Biz Calls', key: 'biz_call_count' },
                          ].filter(f => limits[f.key] != null).map(({ label, key }) => {
                            const pct = limits[key];
                            const color = pct > 75 ? '#dc2626' : pct > 40 ? '#f59e0b' : 'var(--green)';
                            return (
                              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 5 }}>
                                <div style={{ width: 80, fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>{label}</div>
                                <div style={{ flex: 1, background: 'var(--bg)', borderRadius: 4, height: 10, overflow: 'hidden' }}>
                                  <div style={{ width: `${Math.min(pct, 100)}%`, height: '100%', background: color, borderRadius: 4, transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ width: 36, fontSize: 12, textAlign: 'right', color, fontWeight: 600 }}>{pct}%</div>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Cache keys */}
                  {apiStats.cacheKeys.length > 0 && (
                    <div style={{ marginBottom: 20 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Cached Entries</div>
                      <div style={{ background: 'var(--bg)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                        {apiStats.cacheKeys.map(({ key, age, expiresIn }) => (
                          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 12px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                            <span style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{key}</span>
                            <span style={{ color: 'var(--text-muted)', flexShrink: 0, marginLeft: 12 }}>
                              {age < 60 ? `${age}s` : `${Math.floor(age/60)}m`} old · expires in {expiresIn < 60 ? `${expiresIn}s` : `${Math.floor(expiresIn/60)}m`}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recent calls */}
                  {apiStats.recentCalls.length > 0 && (
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Recent API Calls</div>
                      <div style={{ background: 'var(--bg)', borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)', maxHeight: 220, overflowY: 'auto' }}>
                        {apiStats.recentCalls.map((c, i) => {
                          const ago = Math.round((Date.now() - c.ts) / 1000);
                          return (
                            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 12px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                              <span style={{ color: 'var(--text-muted)', flexShrink: 0, marginRight: 12 }}>{ago < 60 ? `${ago}s ago` : `${Math.floor(ago/60)}m ago`}</span>
                              <span style={{ fontFamily: 'monospace', flex: 1 }}>{c.path}</span>
                              <span style={{ color: 'var(--text-muted)', flexShrink: 0, marginLeft: 12 }}>{c.account}</span>
                              {c.pages > 1 && <span style={{ color: 'var(--text-muted)', flexShrink: 0, marginLeft: 8 }}>{c.pages}p</span>}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
      {kpiModal && (
        <KpiModal
          campaignId={kpiModal.campaignId}
          campaignName={kpiModal.campaignName}
          currentKpis={kpisMap[kpiModal.campaignId] || {}}
          onSave={saveKpis}
          onClose={() => setKpiModal(null)}
        />
      )}

      {/* AI Analysis Popup */}
      {popup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 500,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onDoubleClick={() => setPopup(null)}>
          <div style={{ background: 'var(--surface)', borderRadius: 14, padding: 24, width: 680,
            maxWidth: '95vw', minWidth: 360, minHeight: 200, maxHeight: '92vh', overflowY: 'auto',
            resize: 'both', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>{popupRow?.name}</div>
                {popupAnalysis && !popupAnalysis.loading && !popupAnalysis.error && (
                  <RatingBadge rating={popupAnalysis.rating} />
                )}
              </div>
              <button onClick={() => setPopup(null)} style={{ background: 'none', border: 'none',
                cursor: 'pointer', fontSize: 18, color: 'var(--text-muted)', padding: '0 4px', marginLeft: 12 }}>✕</button>
            </div>

            {/* Trend section */}
            {popupRow && (() => {
              const cache = adDailyCache[popupRow.id] || {};
              return <AdTrendSection rows={cache.rows} loading={!!cache.loading} error={cache.error} />;
            })()}

            {/* Divider */}
            {popupAnalysis && !popupAnalysis.loading && !popupAnalysis.error && (
              <div style={{ borderTop: '1px solid var(--border)', marginBottom: 16 }} />
            )}

            {/* Loading */}
            {(!popupAnalysis || popupAnalysis.loading) && (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Analyzing…</div>
            )}

            {/* Error */}
            {popupAnalysis?.error && (
              <div style={{ color: '#dc2626', fontSize: 13 }}>Error: {popupAnalysis.error}</div>
            )}

            {/* AI results */}
            {popupAnalysis && !popupAnalysis.loading && !popupAnalysis.error && (
              <>
                <p style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text)', margin: '0 0 14px' }}>
                  {popupAnalysis.summary}
                </p>
                {popupAnalysis.insights?.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 6 }}>Insights</div>
                    <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12, lineHeight: 1.7 }}>
                      {popupAnalysis.insights.map((ins, i) => <li key={i}>{ins}</li>)}
                    </ul>
                  </div>
                )}
                {popupAnalysis.recommendations?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
                      letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 6 }}>Recommendations</div>
                    <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: 12, lineHeight: 1.7, color: '#15803d' }}>
                      {popupAnalysis.recommendations.map((rec, i) => <li key={i}>{rec}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}

            {/* Footer */}
            <div style={{ marginTop: 18, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {popupRow && (
                <button className="btn btn--sm" onClick={() => analyzeRow(popupRow, popupLevel)}>
                  Re-analyze
                </button>
              )}
              <button className="btn btn--sm" onClick={() => setPopup(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Campaign Reports</div>
        <button className="btn btn--sm" onClick={() => setShowRules(true)}
          title="Manage AI rules and standing instructions"
          style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 5 }}>
          🧠 AI Rules
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {PRESETS.map(p => {
            const ps = p.start(), pe = p.end();
            const active = start === ps && end === pe;
            return (
              <button key={p.label} className="btn btn--sm"
                onClick={() => setDateRange({ start: ps, end: pe })}
                style={active ? { background: 'var(--green)', color: '#fff', border: 'none' } : {}}>
                {p.label}
              </button>
            );
          })}
          <DateRangePicker start={start} end={end} onChange={setDateRange} />
          <button className="btn btn--sm" onClick={loadAll} disabled={loading} style={{ marginLeft: 4 }}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button className="btn btn--sm" title="View FB API usage stats"
            onClick={() => { setShowApiStats(true); fetchApiStats(); }}
            style={{ marginLeft: 4, fontSize: 13 }}>📊 API</button>
        </div>
      </div>

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 16 }}>Error: {error}</div>}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 160px)' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: '0 3px', width: '100%', minWidth: 1400 }}>
            <thead>
              <tr>
                <th style={{ width: 36, padding: '9px 4px', borderBottom: '2px solid var(--border)',
                  background: 'var(--surface)', position: 'sticky', top: 0, left: 0, zIndex: 12 }} />
                {COLS.map(col => (
                  <th key={col.key} style={thStyle(col)} onClick={() => handleSort(col.key)}
                    title={`Sort by ${col.label}`}>
                    {col.label}{sortIndicator(col.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Active campaigns */}
              {sortRows(campaigns.filter(isActive), sortKey, sortDir).map(c => renderCampaignGroup(c))}

              {/* Paused campaigns footer */}
              {campaigns.filter(c => !isActive(c)).length > 0 && (
                <>
                  <tr style={{ cursor: 'pointer' }} onClick={() => setShowPausedCampaigns(v => !v)}>
                    <td colSpan={COLS.length + 1} style={pausedFooterStyle}>
                      {showPausedCampaigns ? '▾' : '▸'} {campaigns.filter(c => !isActive(c)).length} paused campaign{campaigns.filter(c => !isActive(c)).length !== 1 ? 's' : ''}
                    </td>
                  </tr>
                  {showPausedCampaigns && sortRows(campaigns.filter(c => !isActive(c)), sortKey, sortDir).map(c => renderCampaignGroup(c))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
