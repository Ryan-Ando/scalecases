import { useState, useEffect, useMemo } from 'react';
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
  if (item.dailyBudget)    return `$${(parseFloat(item.dailyBudget) / 100).toFixed(0)}/day`;
  if (item.lifetimeBudget) return `$${(parseFloat(item.lifetimeBudget) / 100).toFixed(0)} ltm`;
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
    case 'cost_per_result':       return parseFloat(r.cost_per_result || 0) || 1e9;
    case 'unique_clicks':         return parseFloat(r.unique_clicks || 0);
    case 'cost_per_unique_click': return parseFloat(r.cost_per_unique_click || 0) || 1e9;
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
    case 'cost_per_result':       return fmt$(r.cost_per_result);
    case 'unique_clicks':         return fmtN(r.unique_clicks);
    case 'cost_per_unique_click': return fmt$(r.cost_per_unique_click);
    case 'frequency':             return fmtN(r.frequency);
    case 'cpm':                   return fmt$(r.cpm);
    case 'unique_ctr':            return fmtPct(r.unique_ctr);
    case 'videoTime':             return fmtVideo(r.video_avg_time_watched_actions);
    case 'createdTime':           return fmtDate(r.createdTime || r.created_time);
    default:                      return '—';
  }
}

function DrillTable({ rows, onRowClick, label = 'Ad Set' }) {
  // Default: ACTIVE first, then newest created
  const [sortKey, setSortKey] = useState('_default');
  const [sortDir, setSortDir] = useState('asc');

  const sorted = useMemo(() => {
    const arr = [...rows];
    if (sortKey === '_default') {
      return arr.sort((a, b) => {
        const d = deliveryOrder(a) - deliveryOrder(b);
        if (d !== 0) return d;
        const ca = a.createdTime || a.created_time || '';
        const cb = b.createdTime || b.created_time || '';
        return cb.localeCompare(ca); // newest first
      });
    }
    return arr.sort((a, b) => {
      const av = getSortVal(a, sortKey);
      const bv = getSortVal(b, sortKey);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }, [rows, sortKey, sortDir]);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
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

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 320px)',
      border: '1px solid var(--border)', borderRadius: 10 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1200 }}>
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
                  {cellVal(r, col.key)}
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

  const [analyses, setAnalyses]   = useState({});
  const [training, setTraining]   = useState({});
  const [noteInputs, setNoteInputs] = useState({});

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

  // ── Drill: campaign → adsets ──────────────────────────────────────────────
  async function fetchAdsetData(campaign, s, e) {
    setAdsets([]); setTrendData([]);
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
          leads: (r.actions || []).reduce((s, a) =>
            ['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead','contact']
              .includes(a.action_type) ? s + parseInt(a.value, 10) : s, 0),
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
      setAnalyses(prev => ({ ...prev, [id]: data }));
    } catch (e) {
      setAnalyses(prev => ({ ...prev, [id]: { error: e.message } }));
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
          {/* Date range inputs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
            <input type="date" value={start} max={end}
              onChange={e => setDateRange(d => ({ ...d, start: e.target.value }))}
              style={{ padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)',
                background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>→</span>
            <input type="date" value={end} min={start} max={todayStr()}
              onChange={e => setDateRange(d => ({ ...d, end: e.target.value }))}
              style={{ padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)',
                background: 'var(--bg)', color: 'var(--text)', fontSize: 12 }} />
          </div>
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
                    <StatBox label="CPL"    value={fmt$(c.cost_per_result)} />
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
            <StatBox label="CPL"    value={fmt$(selCampaign.cost_per_result)} />
            <StatBox label="Clicks" value={fmtN(selCampaign.unique_clicks)} />
            <StatBox label="CPM"    value={fmt$(selCampaign.cpm)} />
            <StatBox label="CTR"    value={fmtPct(selCampaign.unique_ctr)} />
            <StatBox label="Budget" value={fmtBudget(selCampaign)} />
          </div>

          {adsets.length > 0 && !adsetLoading && (
            <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              {analyses[selCampaign.id] && !analyses[selCampaign.id].loading
                ? <RatingBadge rating={analyses[selCampaign.id].rating} /> : null}
              <button className="btn btn--sm" onClick={() => analyze(selCampaign, adsets)}
                disabled={analyses[selCampaign.id]?.loading}>
                {analyses[selCampaign.id]?.loading ? 'Analyzing…' : '✦ Analyze with AI'}
              </button>
            </div>
          )}
          {analyses[selCampaign.id] && !analyses[selCampaign.id].loading && !analyses[selCampaign.id].error && (
            <div style={{ marginBottom: 16, padding: '12px 16px', background: 'var(--bg)',
              border: '1px solid var(--border)', borderRadius: 10, fontSize: 13 }}>
              <div style={{ marginBottom: 6, lineHeight: 1.5 }}>{analyses[selCampaign.id].summary}</div>
              {analyses[selCampaign.id].recommendations?.map((r, i) => (
                <div key={i} style={{ fontSize: 12, color: 'var(--green-dark)' }}>→ {r}</div>
              ))}
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
            : <DrillTable rows={adsets} onRowClick={openAdset} label="Ad Set" />}
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
          {adLoading
            ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading ads…</div>
            : <DrillTable rows={ads} label="Ad" />}
        </div>
      )}
    </div>
  );
}
