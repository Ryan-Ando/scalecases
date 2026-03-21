import { useState, useEffect, useMemo, useRef } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer,
} from 'recharts';
import { dbGetAll, dbUpsert, dbDelete } from './db.js';

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

const TIMEFRAMES = [
  { label: 'Today', days: 0 },
  { label: '3d',    days: 3 },
  { label: '7d',    days: 7 },
  { label: '14d',   days: 14 },
  { label: '30d',   days: 30 },
];

function getDateRange(days) {
  const today = new Date().toISOString().slice(0, 10);
  if (days === 0) return { start: today, end: today };
  const start = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  return { start, end: today };
}

function fmt$(v)   { return v != null && v !== '' ? `$${parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'; }
function fmtN(v)   { return v != null && v !== '' ? parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'; }
function fmtPct(v) { return v != null && v !== '' ? `${parseFloat(v).toFixed(2)}%` : '—'; }

function fmtBudget(item) {
  if (item.dailyBudget)    return `$${(parseFloat(item.dailyBudget) / 100).toFixed(0)}/day`;
  if (item.lifetimeBudget) return `$${(parseFloat(item.lifetimeBudget) / 100).toFixed(0)} ltm`;
  return '—';
}

function fmtVideo(arr) {
  if (!Array.isArray(arr)) return '—';
  const v = arr.find(a => a.action_type === 'video_view');
  if (!v) return '—';
  const s = parseFloat(v.value);
  if (!s) return '—';
  return s >= 60
    ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
    : `${s.toFixed(1)}s`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function DeliveryBadge({ status }) {
  const map = {
    ACTIVE:           { label: 'Active',           color: '#16a34a', bg: '#f0fdf4' },
    PAUSED:           { label: 'Paused',            color: '#64748b', bg: '#f1f5f9' },
    CAMPAIGN_PAUSED:  { label: 'Campaign paused',   color: '#f59e0b', bg: '#fffbeb' },
    ADSET_PAUSED:     { label: 'Ad set paused',     color: '#f59e0b', bg: '#fffbeb' },
    ARCHIVED:         { label: 'Archived',          color: '#94a3b8', bg: '#f8fafc' },
    IN_PROCESS:       { label: 'In review',         color: '#3b82f6', bg: '#eff6ff' },
    WITH_ISSUES:      { label: 'Issues',            color: '#dc2626', bg: '#fef2f2' },
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
      color, background: bg, border: `1px solid ${color}44` }}>
      {label}
    </span>
  );
}

function ratingColors(rating) {
  if (rating === 'good')    return { border: '#16a34a', bg: '#f0fdf4' };
  if (rating === 'warning') return { border: '#f59e0b', bg: '#fffbeb' };
  if (rating === 'poor')    return { border: '#dc2626', bg: '#fef2f2' };
  return { border: 'var(--border)', bg: 'var(--surface)' };
}

// ── KPI Modal ────────────────────────────────────────────────────────────────
function KpiModal({ kpis, onSave, onClose }) {
  const [draft, setDraft] = useState({ ...kpis });
  function set(k, v) { setDraft(d => ({ ...d, [k]: v })); }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}>
      <div style={{ background: 'var(--surface)', borderRadius: 14, padding: 28, width: 380,
        boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>Manage KPIs</div>
        {[
          ['targetCpl',  'Target CPL ($)',          'e.g. 80'],
          ['targetCpc',  'Target CPC ($)',           'e.g. 5'],
          ['minLeads',   'Min leads / day',          'e.g. 2'],
        ].map(([k, label, ph]) => (
          <div key={k} style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600,
              color: 'var(--text-muted)', marginBottom: 4 }}>{label}</label>
            <input
              type="number" step="any" placeholder={ph}
              value={draft[k] || ''}
              onChange={e => set(k, e.target.value)}
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
            placeholder="e.g. AZ historically has higher CPL in Q1, SC target market is seniors..."
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
            onClick={() => { onSave(draft); onClose(); }}>Save KPIs</button>
        </div>
      </div>
    </div>
  );
}

// ── Stat row helper ──────────────────────────────────────────────────────────
function StatBox({ label, value, sub }) {
  return (
    <div style={{ minWidth: 80 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600,
        textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

// ── Drilldown table ──────────────────────────────────────────────────────────
function DrillTable({ rows, onRowClick, label = 'Ad Set' }) {
  const tdS = { padding: '8px 12px', fontSize: 12, borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap', color: 'var(--text)' };
  const thS = { padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', borderBottom: '2px solid var(--border)',
    whiteSpace: 'nowrap', background: 'var(--surface)', position: 'sticky', top: 0 };

  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 1100 }}>
        <thead>
          <tr>
            <th style={{ ...thS, textAlign: 'left', minWidth: 200, position: 'sticky', left: 0, zIndex: 2 }}>{label}</th>
            <th style={{ ...thS, textAlign: 'center' }}>Status</th>
            <th style={{ ...thS, textAlign: 'right' }}>Delivery</th>
            <th style={{ ...thS, textAlign: 'right' }}>Budget</th>
            <th style={{ ...thS, textAlign: 'right' }}>Spent</th>
            <th style={{ ...thS, textAlign: 'right' }}>Results</th>
            <th style={{ ...thS, textAlign: 'right' }}>CPL</th>
            <th style={{ ...thS, textAlign: 'right' }}>Uniq Clicks</th>
            <th style={{ ...thS, textAlign: 'right' }}>CPC</th>
            <th style={{ ...thS, textAlign: 'right' }}>Frequency</th>
            <th style={{ ...thS, textAlign: 'right' }}>CPM</th>
            <th style={{ ...thS, textAlign: 'right' }}>Uniq CTR</th>
            <th style={{ ...thS, textAlign: 'right' }}>Video Time</th>
            <th style={{ ...thS, textAlign: 'right' }}>Created</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} onClick={onRowClick ? () => onRowClick(r) : undefined}
              style={{ cursor: onRowClick ? 'pointer' : 'default' }}
              onMouseEnter={e => { if (onRowClick) e.currentTarget.style.background = 'var(--bg)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
              <td style={{ ...tdS, fontWeight: 600, position: 'sticky', left: 0,
                background: 'var(--surface)', maxWidth: 240, overflow: 'hidden',
                textOverflow: 'ellipsis' }}
                title={r.name}>{r.name}</td>
              <td style={{ ...tdS, textAlign: 'center' }}>
                <DeliveryBadge status={r.status === 'ACTIVE' ? 'ACTIVE' : r.status} />
              </td>
              <td style={{ ...tdS, textAlign: 'right' }}>
                <DeliveryBadge status={r.effectiveStatus || r.status} />
              </td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmtBudget(r)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmt$(r.spend)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{r.results ?? '—'}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmt$(r.cost_per_result)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmtN(r.unique_clicks)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmt$(r.cost_per_unique_click)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmtN(r.frequency)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmt$(r.cpm)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmtPct(r.unique_ctr)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmtVideo(r.video_avg_time_watched_actions)}</td>
              <td style={{ ...tdS, textAlign: 'right' }}>{fmtDate(r.createdTime || r.created_time)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={14} style={{ ...tdS, textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>No data</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────
export default function CampaignReports() {
  const [tfDays, setTfDays]           = useState(7);
  const [kpis, setKpis]               = useState(() => { try { return JSON.parse(localStorage.getItem('reportKpis') || '{}'); } catch { return {}; } });
  const [showKpiModal, setShowKpiModal] = useState(false);

  const [campaigns, setCampaigns]     = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');

  // drill-down
  const [view, setView]                   = useState('campaigns');  // 'campaigns' | 'adsets' | 'ads'
  const [selCampaign, setSelCampaign]     = useState(null);
  const [selAdset, setSelAdset]           = useState(null);
  const [adsets, setAdsets]               = useState([]);
  const [ads, setAds]                     = useState([]);
  const [adsetLoading, setAdsetLoading]   = useState(false);
  const [adLoading, setAdLoading]         = useState(false);
  const [trendData, setTrendData]         = useState([]);

  // AI analysis: { [campaignId]: { rating, summary, insights, recommendations } | { loading } | { error } }
  const [analyses, setAnalyses] = useState({});

  // Training notes: { [campaignId]: [{ id, type, text, ts }] }
  const [training, setTraining] = useState({});
  const [noteInputs, setNoteInputs] = useState({});  // campaignId → draft string

  // ── Date range ────────────────────────────────────────────────────────────
  const { start, end } = useMemo(() => getDateRange(tfDays), [tfDays]);
  const tfLabel = tfDays === 0 ? 'Today' : `Last ${tfDays} days`;

  // ── Load training from IndexedDB ──────────────────────────────────────────
  useEffect(() => {
    dbGetAll('campaignTraining').then(rows => {
      const map = {};
      for (const r of rows) {
        if (!map[r.campaignId]) map[r.campaignId] = [];
        map[r.campaignId].push(r);
      }
      // Sort each by ts desc, keep last 20
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

  // ── Load adsets for a campaign ────────────────────────────────────────────
  async function openCampaign(campaign) {
    setSelCampaign(campaign); setView('adsets'); setAdsets([]); setTrendData([]);
    setAdsetLoading(true);
    try {
      const [adsetsRes, trendRes] = await Promise.all([
        fetch(`${BASE}/api/facebook/adsets?campaign_id=${campaign.id}&start=${start}&end=${end}`),
        fetch(`${BASE}/api/facebook/daily?start=${start}&end=${end}&level=campaign`),
      ]);
      const adsetsData = await adsetsRes.json();
      const trendRaw   = await trendRes.json();
      if (!adsetsRes.ok) throw new Error(adsetsData.error || adsetsRes.statusText);
      setAdsets(adsetsData);
      // Filter trend to this campaign, format for recharts
      const filtered = (Array.isArray(trendRaw) ? trendRaw : [])
        .filter(r => r.campaign_id === campaign.id)
        .map(r => ({
          date: r.date_start?.slice(5),  // MM-DD
          spend: parseFloat(r.spend) || 0,
          leads: (r.actions || []).reduce((s, a) =>
            ['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead','contact'].includes(a.action_type)
              ? s + parseInt(a.value, 10) : s, 0),
        }))
        .sort((a, b) => a.date < b.date ? -1 : 1);
      setTrendData(filtered);
    } catch (e) {
      console.error('Adset load error:', e.message);
    } finally {
      setAdsetLoading(false);
    }
  }

  // ── Load ads for an adset ─────────────────────────────────────────────────
  async function openAdset(adset) {
    setSelAdset(adset); setView('ads'); setAds([]);
    setAdLoading(true);
    try {
      const res  = await fetch(`${BASE}/api/facebook/ads?adset_id=${adset.id}&start=${start}&end=${end}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setAds(data);
    } catch (e) {
      console.error('Ad load error:', e.message);
    } finally {
      setAdLoading(false);
    }
  }

  // ── AI Analysis ───────────────────────────────────────────────────────────
  async function analyze(campaign, adsetsForCampaign = []) {
    const id = campaign.id;
    setAnalyses(prev => ({ ...prev, [id]: { loading: true } }));
    const notes = (training[id] || []).slice(0, 8).map(n => ({ type: n.type, text: n.text }));
    try {
      const res  = await fetch(`${BASE}/api/reports/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaign, adsets: adsetsForCampaign, kpis, trainingNotes: notes, timeframeLabel: tfLabel }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setAnalyses(prev => ({ ...prev, [id]: data }));
    } catch (e) {
      setAnalyses(prev => ({ ...prev, [id]: { error: e.message } }));
    }
  }

  // ── Training helpers ──────────────────────────────────────────────────────
  async function addTraining(campaignId, campaignName, type, text) {
    const entry = { id: `${campaignId}_${Date.now()}`, campaignId, campaignName, type, text, ts: Date.now() };
    await dbUpsert('campaignTraining', [entry]);
    setTraining(prev => {
      const existing = prev[campaignId] || [];
      return { ...prev, [campaignId]: [entry, ...existing].slice(0, 20) };
    });
  }

  function saveKpis(next) {
    setKpis(next);
    localStorage.setItem('reportKpis', JSON.stringify(next));
  }

  // ── Breadcrumb navigation ─────────────────────────────────────────────────
  function navTo(level) {
    if (level === 'campaigns') { setView('campaigns'); setSelCampaign(null); setSelAdset(null); }
    if (level === 'adsets')    { setView('adsets'); setSelAdset(null); }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px 28px', minHeight: '100%', boxSizing: 'border-box' }}>
      {showKpiModal && <KpiModal kpis={kpis} onSave={saveKpis} onClose={() => setShowKpiModal(false)} />}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Campaign Reports</div>
        <button className="btn btn--sm" style={{ color: 'var(--text-muted)' }}
          onClick={() => setShowKpiModal(true)}>
          ⚙ KPIs{kpis.targetCpl ? ` · CPL $${kpis.targetCpl}` : ''}
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
          {TIMEFRAMES.map(tf => (
            <button key={tf.days} className={`btn btn--sm${tfDays === tf.days ? ' nav-tab--active' : ''}`}
              onClick={() => setTfDays(tf.days)} style={tfDays === tf.days ? { background: 'var(--green)', color: '#fff', border: 'none' } : {}}>
              {tf.label}
            </button>
          ))}
          <button className="btn btn--sm" onClick={loadCampaigns} disabled={loading} style={{ marginLeft: 8 }}>
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
                : <span style={{ color: 'var(--text)', fontWeight: 600 }}>{selCampaign.name}</span>
              }
            </>
          )}
          {view === 'ads' && selAdset && (
            <><span>/</span><span style={{ color: 'var(--text)', fontWeight: 600 }}>{selAdset.name}</span></>
          )}
        </div>
      )}

      {/* Error */}
      {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 16 }}>Error: {error}</div>}

      {/* ── Campaign grid ───────────────────────────────────────────────── */}
      {view === 'campaigns' && (
        loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading campaigns…</div>
        ) : campaigns.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No active campaigns found for this timeframe.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(520px, 1fr))', gap: 16 }}>
            {campaigns.map(c => {
              const state    = extractState(c.name);
              const analysis = analyses[c.id];
              const { border, bg } = ratingColors(analysis?.rating);
              const notes    = training[c.id] || [];

              return (
                <div key={c.id} style={{
                  border: `1px solid ${border}`,
                  borderLeft: `4px solid ${border}`,
                  borderRadius: 10,
                  background: bg,
                  padding: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 14,
                }}>
                  {/* Tile header */}
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
                    <DeliveryBadge status={c.effectiveStatus || c.status} />
                  </div>

                  {/* Stats */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                    <StatBox label="Spent"   value={fmt$(c.spend)} />
                    <StatBox label="Leads"   value={c.results ?? '—'} />
                    <StatBox label="CPL"     value={fmt$(c.cost_per_result)} />
                    <StatBox label="Clicks"  value={fmtN(c.unique_clicks)} />
                    <StatBox label="CPM"     value={fmt$(c.cpm)} />
                    <StatBox label="Freq"    value={fmtN(c.frequency)} />
                    <StatBox label="CTR"     value={fmtPct(c.unique_ctr)} />
                  </div>

                  {/* AI analysis */}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                    {!analysis && (
                      <button className="btn btn--sm" onClick={() => analyze(c)}
                        style={{ fontSize: 12 }}>
                        ✦ Analyze with AI
                      </button>
                    )}
                    {analysis?.loading && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Analyzing…</div>
                    )}
                    {analysis?.error && (
                      <div style={{ fontSize: 12, color: '#dc2626' }}>AI error: {analysis.error}
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
                        {/* Training feedback */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Was this accurate?</span>
                          <button className="btn btn--sm" title="Accurate"
                            onClick={() => addTraining(c.id, c.name, 'positive', `Analysis on ${new Date().toLocaleDateString()} was accurate`)}>👍</button>
                          <button className="btn btn--sm" title="Inaccurate"
                            onClick={() => addTraining(c.id, c.name, 'negative', `Analysis on ${new Date().toLocaleDateString()} was inaccurate`)}>👎</button>
                          <button className="btn btn--sm" onClick={() => analyze(c)}>Re-analyze</button>
                        </div>
                        {/* Note input */}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                          <input
                            type="text" placeholder="Add a training note…"
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

                  {/* Drill-down button */}
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

      {/* ── Adset view ──────────────────────────────────────────────────── */}
      {view === 'adsets' && selCampaign && (
        <div>
          {/* Campaign summary */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 20,
            padding: '14px 18px', background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 10 }}>
            <StatBox label="Spent"  value={fmt$(selCampaign.spend)} />
            <StatBox label="Leads"  value={selCampaign.results ?? '—'} />
            <StatBox label="CPL"    value={fmt$(selCampaign.cost_per_result)} />
            <StatBox label="Clicks" value={fmtN(selCampaign.unique_clicks)} />
            <StatBox label="CPM"    value={fmt$(selCampaign.cpm)} />
            <StatBox label="CTR"    value={fmtPct(selCampaign.unique_ctr)} />
            <StatBox label="Budget" value={fmtBudget(selCampaign)} />
          </div>

          {/* AI analyze button for this campaign + adsets */}
          {adsets.length > 0 && !adsetLoading && (
            <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              {analyses[selCampaign.id] && !analyses[selCampaign.id].loading
                ? <RatingBadge rating={analyses[selCampaign.id].rating} />
                : null}
              <button className="btn btn--sm" onClick={() => analyze(selCampaign, adsets)}
                disabled={analyses[selCampaign.id]?.loading}>
                {analyses[selCampaign.id]?.loading ? 'Analyzing…' : '✦ Analyze campaign + adsets with AI'}
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

          {/* Trend chart */}
          {trendData.length > 1 && (
            <div style={{ marginBottom: 20, padding: 16, background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Spend & Leads Trend ({tfLabel})</div>
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trendData} margin={{ top: 4, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="spend" orientation="left" tick={{ fontSize: 11 }}
                    tickFormatter={v => `$${v}`} width={55} />
                  <YAxis yAxisId="leads" orientation="right" tick={{ fontSize: 11 }} width={30} />
                  <Tooltip formatter={(val, name) => name === 'spend' ? [`$${val.toFixed(2)}`, 'Spend'] : [val, 'Leads']} />
                  <Legend />
                  <Line yAxisId="spend" type="monotone" dataKey="spend" stroke="#16a34a" strokeWidth={2} dot={false} />
                  <Line yAxisId="leads" type="monotone" dataKey="leads" stroke="#3b82f6" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {adsetLoading
            ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading adsets…</div>
            : <DrillTable rows={adsets} onRowClick={openAdset} label="Ad Set" />
          }
        </div>
      )}

      {/* ── Ad view ─────────────────────────────────────────────────────── */}
      {view === 'ads' && selAdset && (
        <div>
          <div style={{ marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
            Adset: <strong style={{ color: 'var(--text)' }}>{selAdset.name}</strong>
            &nbsp;·&nbsp;Budget {fmtBudget(selAdset)}
            &nbsp;·&nbsp;<DeliveryBadge status={selAdset.effectiveStatus || selAdset.status} />
          </div>
          {adLoading
            ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading ads…</div>
            : <DrillTable rows={ads} label="Ad" />
          }
        </div>
      )}
    </div>
  );
}
