import { useState, useEffect, useRef, useMemo } from 'react';
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
    const spend = subset.reduce((s, r) => s + (parseFloat(r.spend) || 0), 0);
    const leads = subset.reduce((s, r) => s + getLeads(r), 0);
    const days  = subset.length;
    return { spend, leads, days, cpl: leads > 0 ? spend / leads : null,
             spendPerDay: days > 0 ? spend / days : 0, leadsPerDay: days > 0 ? leads / days : 0 };
  }
  const chartData = rows.map(r => ({
    date: r.date_start.slice(5),
    spend: parseFloat(r.spend) || 0,
    leads: getLeads(r),
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

// Pure rendering component — data is fetched by DrillTable and passed in
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

  return (
    <>
      {/* Daily chart — fixed pixel dimensions avoid ResponsiveContainer issues inside overflow:auto */}
      <div style={{ marginBottom: 18 }}>
        <div style={TREND_LABEL}>Daily Performance (all-time)</div>
        <LineChart width={580} height={130} data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} tickLine={false} interval="preserveStartEnd" />
          <YAxis yAxisId="l" orientation="left" tick={{ fontSize: 9 }} tickLine={false} width={42}
            tickFormatter={v => `$${v}`} />
          <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 9 }} tickLine={false} width={20} />
          <Tooltip formatter={(v, n) => [n === 'Spend' ? `$${parseFloat(v).toFixed(2)}` : v, n]}
            contentStyle={{ fontSize: 11 }} />
          <Line yAxisId="l" type="monotone" dataKey="spend" stroke="#6366f1" dot={false}
            strokeWidth={1.5} name="Spend" />
          <Line yAxisId="r" type="monotone" dataKey="leads" stroke="#10b981" dot={false}
            strokeWidth={1.5} name="Leads" />
        </LineChart>
      </div>

      {/* Stats comparison table */}
      <div style={{ marginBottom: 16 }}>
        <div style={TREND_LABEL}>Performance Trend</div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...TREND_TH, textAlign: 'left' }}>Metric</th>
              <th style={TREND_TH}>All-time avg/day</th>
              <th style={TREND_TH}>Last 7d avg/day</th>
              <th style={TREND_TH}>Last 3d avg/day</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...TREND_TD, textAlign: 'left' }}>Spend</td>
              <td style={TREND_TD}>{fmt$(all.spendPerDay)}</td>
              <td style={TREND_TD}>{fmt$(last7.spendPerDay)}<PctTag val={pctChange(last7.spendPerDay, all.spendPerDay)} /></td>
              <td style={TREND_TD}>{fmt$(last3.spendPerDay)}<PctTag val={pctChange(last3.spendPerDay, all.spendPerDay)} /></td>
            </tr>
            <tr>
              <td style={{ ...TREND_TD, textAlign: 'left' }}>Leads</td>
              <td style={TREND_TD}>{all.leadsPerDay.toFixed(2)}</td>
              <td style={TREND_TD}>{last7.leadsPerDay.toFixed(2)}<PctTag val={pctChange(last7.leadsPerDay, all.leadsPerDay)} invert /></td>
              <td style={TREND_TD}>{last3.leadsPerDay.toFixed(2)}<PctTag val={pctChange(last3.leadsPerDay, all.leadsPerDay)} invert /></td>
            </tr>
            <tr>
              <td style={{ ...TREND_TD, borderBottom: 'none', textAlign: 'left' }}>CPL</td>
              <td style={{ ...TREND_TD, borderBottom: 'none' }}>{all.cpl ? fmt$(all.cpl) : '—'}</td>
              <td style={{ ...TREND_TD, borderBottom: 'none' }}>
                {last7.cpl ? fmt$(last7.cpl) : '—'}<PctTag val={pctChange(last7.cpl, all.cpl)} />
              </td>
              <td style={{ ...TREND_TD, borderBottom: 'none' }}>
                {last3.cpl ? fmt$(last3.cpl) : '—'}<PctTag val={pctChange(last3.cpl, all.cpl)} />
              </td>
            </tr>
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

function RatingBadge({ rating }) {
  if (!rating) return null;
  const map = { good: ['Good', '#16a34a', '#f0fdf4'], warning: ['Needs Attention', '#f59e0b', '#fffbeb'], poor: ['Underperforming', '#dc2626', '#fef2f2'] };
  const [label, color, bg] = map[rating] || ['Unknown', '#94a3b8', '#f8fafc'];
  return (
    <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20,
      color, background: bg, border: `1px solid ${color}44` }}>{label}</span>
  );
}

function ratingColors(rating) {
  if (rating === 'good')    return { border: '#16a34a', bg: '#f0fdf4' };
  if (rating === 'warning') return { border: '#f59e0b', bg: '#fffbeb' };
  if (rating === 'poor')    return { border: '#dc2626', bg: '#fef2f2' };
  return { border: 'var(--border)', bg: 'var(--surface)' };
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

// ── Sortable drill-down table ─────────────────────────────────────────────────
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

function DrillTable({ rows, onRowClick, label = 'Ad Set', rowAnalyses = {}, onAnalyzeRow, dailyRows = [], level = 'adset' }) {
  const [sortKey, setSortKey]         = useState('_default');
  const [sortDir, setSortDir]         = useState('asc');
  const [popup, setPopup]             = useState(null);
  const [adDailyCache, setAdDailyCache] = useState({}); // adId → { loading, rows, error }

  const sorted = useMemo(() => {
    const arr = [...rows];
    if (sortKey === '_default') {
      return arr.sort((a, b) => {
        const d = deliveryOrder(a) - deliveryOrder(b);
        if (d !== 0) return d;
        const ca = a.createdTime || a.created_time || '';
        const cb = b.createdTime || b.created_time || '';
        return cb.localeCompare(ca);
      });
    }
    if (sortKey === 'aiStatus') {
      const ratingOrder = r => {
        const a = rowAnalyses[r.id];
        if (!a || a.loading || a.error) return 3;
        return { good: 0, warning: 1, poor: 2 }[a.rating] ?? 3;
      };
      return arr.sort((a, b) => {
        const av = ratingOrder(a), bv = ratingOrder(b);
        if (av !== bv) return sortDir === 'asc' ? av - bv : bv - av;
        return 0;
      });
    }
    return arr.sort((a, b) => {
      const av = getSortVal(a, sortKey);
      const bv = getSortVal(b, sortKey);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }, [rows, sortKey, sortDir, rowAnalyses]);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  // Fetch daily data when a popup opens (works for both ads and adsets)
  useEffect(() => {
    if (!popup) return;
    if (adDailyCache[popup]) return;
    const idField  = level === 'ad' ? 'ad_id' : 'adset_id';
    const param    = level === 'ad' ? 'ad_ids' : 'adset_ids';
    const fromProp = dailyRows.filter(r => r[idField] === popup);
    if (fromProp.length) {
      setAdDailyCache(prev => ({ ...prev, [popup]: { rows: fromProp } }));
      return;
    }
    setAdDailyCache(prev => ({ ...prev, [popup]: { loading: true } }));
    fetch(`${BASE}/api/facebook/daily?date_preset=maximum&${param}=${encodeURIComponent(popup)}`)
      .then(r => r.json())
      .then(data => setAdDailyCache(prev => ({ ...prev, [popup]: { rows: Array.isArray(data) ? data : [] } })))
      .catch(e  => setAdDailyCache(prev => ({ ...prev, [popup]: { error: e.message, rows: [] } })));
  }, [level, popup, adDailyCache, dailyRows]);

  function handleAiClick(e, r) {
    e.stopPropagation();
    if (!rowAnalyses[r.id] || rowAnalyses[r.id].error) onAnalyzeRow && onAnalyzeRow(r);
    setPopup(r.id);
  }

  function renderAiCell(r) {
    const a = rowAnalyses[r.id];
    if (!a) return (
      <button className="btn btn--sm" style={{ fontSize: 10, padding: '2px 8px' }}
        onClick={e => handleAiClick(e, r)}>Analyze</button>
    );
    if (a.loading) return <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>…</span>;
    if (a.error) return (
      <button className="btn btn--sm" style={{ fontSize: 10, color: '#dc2626' }}
        onClick={e => handleAiClick(e, r)}>Retry</button>
    );
    return (
      <div onClick={e => handleAiClick(e, r)} style={{ cursor: 'pointer', display: 'inline-block' }}>
        <RatingBadge rating={a.rating} />
      </div>
    );
  }

  const thBase = {
    padding: '9px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '2px solid var(--border)',
    whiteSpace: 'nowrap', background: 'var(--surface)', position: 'sticky', top: 0,
    cursor: 'pointer', userSelect: 'none',
  };
  const tdBase = {
    padding: '8px 12px', fontSize: 12, borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap', color: 'var(--text)',
  };

  const displayLabel = col => col.key === 'name' ? label : col.label;

  const popupRow      = popup ? rows.find(r => r.id === popup) : null;
  const popupAnalysis = popup ? rowAnalyses[popup] : null;

  return (
    <div>
      {/* AI analysis popup */}
      {popup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 500,
          display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setPopup(null)}>
          <div style={{ background: 'var(--surface)', borderRadius: 14, padding: 24,
            width: 660, maxWidth: '95vw',
            maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
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

            {/* Trend section — chart + stats table */}
            {popupRow && (() => {
              const cache = adDailyCache[popupRow.id] || {};
              return <AdTrendSection rows={cache.rows} loading={!!cache.loading} error={cache.error} />;
            })()}

            {/* Divider between trend and AI analysis */}
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
                <button className="btn btn--sm" onClick={() => { onAnalyzeRow && onAnalyzeRow(popupRow); }}>
                  Re-analyze
                </button>
              )}
              <button className="btn btn--sm" onClick={() => setPopup(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 320px)',
        border: '1px solid var(--border)', borderRadius: 10 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1300 }}>
          <thead>
            <tr>
              {COLS.map(col => (
                <th key={col.key}
                  style={{
                    ...thBase,
                    textAlign: col.align || 'right',
                    ...(col.sticky ? { position: 'sticky', left: 0, zIndex: 3, top: 0 } : {}),
                  }}
                  onClick={() => handleSort(col.key)}
                  title={`Sort by ${col.label}`}
                >
                  {displayLabel(col)}
                  {sortKey === col.key
                    ? <span style={{ marginLeft: 4, fontSize: 9 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                    : <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.3 }}>⇅</span>
                  }
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => (
              <tr key={r.id}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                style={{ cursor: onRowClick ? 'pointer' : 'default' }}
                onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background = 'var(--bg)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
                {COLS.map(col => (
                  <td key={col.key} style={{
                    ...tdBase,
                    textAlign: col.align || 'right',
                    ...(col.sticky ? {
                      position: 'sticky', left: 0, zIndex: 1,
                      background: 'var(--surface)', maxWidth: 240,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    } : {}),
                  }}>
                    {col.key === 'aiStatus' ? renderAiCell(r) : cellVal(r, col.key)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={COLS.length} style={{ ...tdBase, textAlign: 'center',
                color: 'var(--text-muted)', padding: 24 }}>No data</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
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

  const [view, setView]               = useState('campaigns');
  const [selCampaign, setSelCampaign] = useState(null);
  const [selAdset, setSelAdset]       = useState(null);
  const [adsets, setAdsets]           = useState([]);
  const [ads, setAds]                 = useState([]);
  const [adsetLoading, setAdsetLoading] = useState(false);
  const [adLoading, setAdLoading]       = useState(false);
  const [trendData, setTrendData]       = useState([]);

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

    dbGetAll('adDailyInsights').then(rows => {
      setAdDailyInsights(rows);
    }).catch(() => {});
  }, []);

  // ── Load campaigns ────────────────────────────────────────────────────────
  async function loadCampaigns() {
    setLoading(true); setError('');
    try {
      const res  = await fetch(`${BASE}/api/facebook/campaigns?start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
setCampaigns(data.filter(c => c.effectiveStatus === 'ACTIVE' || c.status === 'ACTIVE'));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadCampaigns(); }, [start, end]);

  // Keep selCampaign stats fresh when campaigns reload (date range change)
  useEffect(() => {
    if (!selCampaign) return;
    const updated = campaigns.find(c => c.id === selCampaign.id);
    if (updated) setSelCampaign(updated);
  }, [campaigns]);

  // ── Drill: campaign → adsets ──────────────────────────────────────────────
  async function fetchAdsetData(campaign, s, e) {
    setAdsets([]); setTrendData([]);
    const savedRows = await dbGetMeta(`rowAnalyses_${campaign.id}`).catch(() => null);
    setRowAnalyses(savedRows && typeof savedRows === 'object' ? savedRows : {});
    setAdsetLoading(true);
    try {
      const [ar, tr] = await Promise.all([
        fetch(`${BASE}/api/facebook/adsets?campaign_id=${campaign.id}&start=${s}&end=${e}`),
        fetch(`${BASE}/api/facebook/daily?start=${s}&end=${e}&level=campaign`),
      ]);
      const adsetsData = await ar.json();
      const trendRaw   = await tr.json();
      if (!ar.ok) throw new Error(adsetsData.error);
      setAdsets(adsetsData);
      const filtered = (Array.isArray(trendRaw) ? trendRaw : [])
        .filter(r => r.campaign_id === campaign.id)
        .map(r => ({
          date: r.date_start?.slice(5),
          spend: parseFloat(r.spend) || 0,
          leads: (() => {
            const types = ['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead','contact','schedule','submit_application'];
            for (const t of types) {
              const a = (r.actions || []).find(x => x.action_type === t);
              if (a) return parseInt(a.value, 10) || 0;
            }
            return 0;
          })(),
        }))
        .sort((a, b) => a.date < b.date ? -1 : 1);
      setTrendData(filtered);
    } catch (e) {
      console.error('Adset load error:', e.message);
    } finally {
      setAdsetLoading(false);
    }
  }

  function openCampaign(campaign) {
    setSelCampaign(campaign); setView('adsets');
    fetchAdsetData(campaign, start, end);
  }

  // Re-fetch adset data when date range changes while in adset view
  useEffect(() => {
    if (view === 'adsets' && selCampaign) fetchAdsetData(selCampaign, start, end);
  }, [start, end, view]);

  // ── Drill: adset → ads ────────────────────────────────────────────────────
  async function fetchAdData(adset, s, e) {
    setAds([]);
    setAdLoading(true);
    try {
      const res  = await fetch(`${BASE}/api/facebook/ads?adset_id=${adset.id}&start=${s}&end=${e}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAds(data);
    } catch (e) {
      console.error('Ad load error:', e.message);
    } finally {
      setAdLoading(false);
    }
  }

  function openAdset(adset) {
    setSelAdset(adset); setView('ads');
    fetchAdData(adset, start, end);
  }

  // Re-fetch ad data when date range changes while in ads view
  useEffect(() => {
    if (view === 'ads' && selAdset) fetchAdData(selAdset, start, end);
  }, [start, end, view]);

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
    const campaignId = row.campaignId || selCampaign?.id;
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
        const cid = selCampaign?.id;
        if (cid) dbSetMeta(`rowAnalyses_${cid}`, next).catch(() => {});
        return next;
      });
    } catch (e) {
      setRowAnalyses(prev => ({ ...prev, [id]: { error: e.message } }));
    }
  }

  // ── Batch AI analysis — one API call for all rows ────────────────────────
  async function analyzeAllRows(rows, level) {
    if (!rows.length) return;
    setRowAnalyses(prev => {
      const next = { ...prev };
      for (const r of rows) next[r.id] = { loading: true };
      return next;
    });
    const campaignId = selCampaign?.id;
    const kpis = campaignId ? (kpisMap[campaignId] || {}) : {};
    const [globalRules, campaignRules, storedDaily] = await Promise.all([
      dbGetMeta('aiRules_global').catch(() => ''),
      campaignId ? dbGetMeta(`aiRules_${campaignId}`).catch(() => '') : Promise.resolve(''),
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
        const cid = selCampaign?.id;
        if (cid) dbSetMeta(`rowAnalyses_${cid}`, next).catch(() => {});
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

  // ── Navigation ────────────────────────────────────────────────────────────
  function navTo(level) {
    if (level === 'campaigns') { setView('campaigns'); setSelCampaign(null); setSelAdset(null); }
    if (level === 'adsets')    { setView('adsets'); setSelAdset(null); }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px 28px', minHeight: '100%', boxSizing: 'border-box' }}>

      {/* AI Rules modal */}
      {showRules && (
        <AiRulesModal campaigns={campaigns} onClose={() => setShowRules(false)} />
      )}

      {/* Per-campaign KPI modal */}
      {kpiModal && (
        <KpiModal
          campaignId={kpiModal.campaignId}
          campaignName={kpiModal.campaignName}
          currentKpis={kpisMap[kpiModal.campaignId] || {}}
          onSave={saveKpis}
          onClose={() => setKpiModal(null)}
        />
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
          {/* Preset buttons */}
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
          <button className="btn btn--sm" onClick={loadCampaigns} disabled={loading} style={{ marginLeft: 4 }}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Breadcrumb */}
      {view !== 'campaigns' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13,
          color: 'var(--text-muted)', marginBottom: 16 }}>
          <button className="btn btn--sm" onClick={() => navTo('campaigns')}>← Campaigns</button>
          {selCampaign && (
            <>
              <span>/</span>
              {view === 'ads'
                ? <button className="btn btn--sm" onClick={() => navTo('adsets')}>{selCampaign.name}</button>
                : <span style={{ color: 'var(--text)', fontWeight: 600 }}>{selCampaign.name}</span>}
            </>
          )}
          {view === 'ads' && selAdset && (
            <><span>/</span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{selAdset.name}</span></>
          )}
        </div>
      )}

      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 16 }}>Error: {error}</div>}

      {/* ── Campaign grid ─────────────────────────────────────────────────── */}
      {view === 'campaigns' && (
        loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading campaigns…</div>
        ) : campaigns.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No active campaigns found.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(520px, 1fr))', gap: 16 }}>
            {campaigns.map(c => {
              const state    = extractState(c.name);
              const analysis = analyses[c.id];
              const { border, bg } = ratingColors(analysis?.rating);
              const notes    = training[c.id] || [];
              const hasKpis  = KPI_FIELDS.some(f => kpisMap[c.id]?.[f.key]);

              return (
                <div key={c.id} style={{ border: `1px solid ${border}`, borderLeft: `4px solid ${border}`,
                  borderRadius: 10, background: bg, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>

                  {/* Header */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{c.name}</div>
                        {state && (
                          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px',
                            borderRadius: 20, background: '#dbeafe', color: '#1d4ed8' }}>{state}</span>
                        )}
                        {analysis?.rating && <RatingBadge rating={analysis.rating} />}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                        {c.objective} · Budget {fmtBudget(c)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <button className="btn btn--sm"
                        onClick={() => setKpiModal({ campaignId: c.id, campaignName: c.name })}
                        title={hasKpis ? 'Edit KPIs' : 'Set KPIs (no targets yet)'}
                        style={{ fontSize: 11, color: hasKpis ? 'var(--green-dark)' : 'var(--text-muted)' }}>
                        ⚙ KPIs{hasKpis ? ' ✓' : ''}
                      </button>
                      <DeliveryBadge status={c.effectiveStatus || c.status} />
                    </div>
                  </div>

                  {/* Stats */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                    <StatBox label="Spent"  value={fmt$(c.spend)} />
                    <StatBox label="Leads"  value={c.results ?? '—'} />
                    <StatBox label="CPL"    value={fmt$(clientCpl(c))} />
                    <StatBox label="Clicks" value={fmtN(c.unique_clicks)} />
                    <StatBox label="CPM"    value={fmt$(c.cpm)} />
                    <StatBox label="Freq"   value={fmtN(c.frequency)} />
                    <StatBox label="CTR"    value={fmtPct(c.unique_ctr)} />
                  </div>

                  {/* AI section */}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    {!analysis && (
                      <button className="btn btn--sm" onClick={() => analyze(c)} style={{ fontSize: 12 }}>
                        ✦ Analyze with AI
                      </button>
                    )}
                    {analysis?.loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Analyzing…</div>}
                    {analysis?.error && (
                      <div style={{ fontSize: 12, color: '#dc2626' }}>
                        AI error: {analysis.error}
                        <button className="btn btn--sm" style={{ marginLeft: 8 }} onClick={() => analyze(c)}>Retry</button>
                      </div>
                    )}
                    {analysis && !analysis.loading && !analysis.error && (
                      <div>
                        <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, marginBottom: 8 }}>
                          {analysis.summary}
                        </div>
                        {analysis.insights?.length > 0 && (
                          <ul style={{ margin: '0 0 8px 0', padding: '0 0 0 16px', fontSize: 12,
                            color: 'var(--text-muted)', lineHeight: 1.6 }}>
                            {analysis.insights.map((ins, i) => <li key={i}>{ins}</li>)}
                          </ul>
                        )}
                        {analysis.recommendations?.length > 0 && (
                          <div style={{ fontSize: 12, color: 'var(--green-dark)', marginBottom: 8 }}>
                            <strong>Recommendations:</strong>
                            <ul style={{ margin: '4px 0 0 0', padding: '0 0 0 16px', lineHeight: 1.6 }}>
                              {analysis.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                            </ul>
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Was this accurate?</span>
                          <button className="btn btn--sm"
                            onClick={() => addTraining(c.id, c.name, 'positive', `Analysis ${new Date().toLocaleDateString()} was accurate`)}>👍</button>
                          <button className="btn btn--sm"
                            onClick={() => addTraining(c.id, c.name, 'negative', `Analysis ${new Date().toLocaleDateString()} was inaccurate`)}>👎</button>
                          <button className="btn btn--sm" onClick={() => analyze(c)}>Re-analyze</button>
                        </div>
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <input type="text" placeholder="Add a training note…"
                            value={noteInputs[c.id] || ''}
                            onChange={e => setNoteInputs(p => ({ ...p, [c.id]: e.target.value }))}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && noteInputs[c.id]?.trim()) {
                                addTraining(c.id, c.name, 'note', noteInputs[c.id].trim());
                                setNoteInputs(p => ({ ...p, [c.id]: '' }));
                              }
                            }}
                            style={{ flex: 1, padding: '5px 10px', borderRadius: 8, fontSize: 12,
                              border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
                          />
                          <button className="btn btn--sm" onClick={() => {
                            if (noteInputs[c.id]?.trim()) {
                              addTraining(c.id, c.name, 'note', noteInputs[c.id].trim());
                              setNoteInputs(p => ({ ...p, [c.id]: '' }));
                            }
                          }}>Save</button>
                        </div>
                        {notes.length > 0 && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                            {notes.length} training note{notes.length !== 1 ? 's' : ''} saved
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  <button className="btn btn--sm" onClick={() => openCampaign(c)}
                    style={{ alignSelf: 'flex-start', fontSize: 12 }}>
                    View Adsets →
                  </button>
                </div>
              );
            })}
          </div>
        )
      )}

      {/* ── Adset view ────────────────────────────────────────────────────── */}
      {view === 'adsets' && selCampaign && (
        <div>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20,
            padding: '14px 18px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }}>
            <StatBox label="Spent"  value={fmt$(selCampaign.spend)} />
            <StatBox label="Leads"  value={selCampaign.results ?? '—'} />
            <StatBox label="CPL"    value={fmt$(clientCpl(selCampaign))} />
            <StatBox label="Clicks" value={fmtN(selCampaign.unique_clicks)} />
            <StatBox label="CPM"    value={fmt$(selCampaign.cpm)} />
            <StatBox label="CTR"    value={fmtPct(selCampaign.unique_ctr)} />
            <StatBox label="Budget" value={fmtBudget(selCampaign)} />
          </div>

          {adsets.length > 0 && !adsetLoading && (
            <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              {(() => {
                const active = adsets.filter(a => a.effectiveStatus === 'ACTIVE');
                const batchLoading = active.some(a => rowAnalyses[a.id]?.loading);
                const done = active.filter(a => rowAnalyses[a.id] && !rowAnalyses[a.id].loading && !rowAnalyses[a.id].error).length;
                return (
                  <>
                    {done > 0 && (
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {done}/{active.length} active analyzed
                      </span>
                    )}
                    <button className="btn btn--sm" disabled={batchLoading || !active.length}
                      onClick={() => analyzeAllRows(active, 'adset')}>
                      {batchLoading ? 'Analyzing…' : `✦ Analyze Active (${active.length})`}
                    </button>
                  </>
                );
              })()}
            </div>
          )}

          {trendData.length > 1 && (
            <div style={{ marginBottom: 20, padding: 16, background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Spend & Leads — {tfLabel}</div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trendData} margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="spend" orientation="left" tick={{ fontSize: 11 }} tickFormatter={v => `$${v}`} width={55} />
                  <YAxis yAxisId="leads" orientation="right" tick={{ fontSize: 11 }} width={30} />
                  <Tooltip formatter={(val, name) => name === 'spend' ? [`$${val.toFixed(2)}`, 'Spend'] : [val, 'Leads']} />
                  <Legend />
                  <Line yAxisId="spend" type="linear" dataKey="spend" stroke="#16a34a" strokeWidth={2} dot={{ r: 3 }} />
                  <Line yAxisId="leads" type="linear" dataKey="leads" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {adsetLoading
            ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading adsets…</div>
            : <DrillTable rows={adsets} onRowClick={openAdset} label="Ad Set" level="adset"
                rowAnalyses={rowAnalyses} onAnalyzeRow={r => analyzeRow(r, 'adset')} />}
        </div>
      )}

      {/* ── Ad view ───────────────────────────────────────────────────────── */}
      {view === 'ads' && selAdset && (
        <div>
          <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
            Ad set: <strong style={{ color: 'var(--text)' }}>{selAdset.name}</strong>
            &nbsp;·&nbsp;Budget {fmtBudget(selAdset)}
            &nbsp;·&nbsp;<DeliveryBadge status={selAdset.effectiveStatus || selAdset.status} />
          </div>
          {adLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading ads…</div>
          ) : (
            <>
              {ads.length > 0 && (
                <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
                  {(() => {
                    const active = ads.filter(a => a.effectiveStatus === 'ACTIVE');
                    const batchLoading = active.some(a => rowAnalyses[a.id]?.loading);
                    const done = active.filter(a => rowAnalyses[a.id] && !rowAnalyses[a.id].loading && !rowAnalyses[a.id].error).length;
                    return (
                      <>
                        {done > 0 && (
                          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                            {done}/{active.length} active analyzed
                          </span>
                        )}
                        <button className="btn btn--sm" disabled={batchLoading || !active.length}
                          onClick={() => analyzeAllRows(active, 'ad')}>
                          {batchLoading ? 'Analyzing…' : `✦ Analyze Active (${active.length})`}
                        </button>
                      </>
                    );
                  })()}
                </div>
              )}
              <DrillTable rows={ads} label="Ad" level="ad" dailyRows={adDailyInsights}
                rowAnalyses={rowAnalyses} onAnalyzeRow={r => analyzeRow(r, 'ad')} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
