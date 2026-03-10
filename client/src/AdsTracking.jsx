import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { dbGetAll, dbUpsert, dbGetMeta, dbSetMeta, dbClearAll, dbDelete, dbClearStore } from './db.js';

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

// Split campaign name on separators and return the last token that is a valid US state.
function extractState(campaignName) {
  if (!campaignName) return null;
  const tokens = campaignName.trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase();
    if (US_STATES.has(t)) return t;
  }
  return null;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDateNum(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

function parseAdNameDate(adName) {
  const m = (adName || '').match(/^(\d{2})(\d{2})[-\s]/);
  if (!m) return null;
  const mm = parseInt(m[1]);
  const dd = parseInt(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const now  = new Date();
  const year = mm <= now.getMonth() + 1 ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(year, mm - 1, dd).toISOString();
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const CHART_METRICS = [
  { key: 'leads', label: 'Leads/Day', color: '#3a8f5c', fmt: v => v },
  { key: 'spend', label: 'Spend/Day', color: '#6366f1', fmt: v => `$${v}` },
  { key: 'cpm',   label: 'CPM/Day',   color: '#f59e0b', fmt: v => v != null ? `$${v}` : '—' },
  { key: 'cpl',   label: 'Cost/Lead', color: '#ef4444', fmt: v => v != null ? `$${v}` : '—' },
];

const MODAL_METRICS = [
  { key: 'leads', label: 'Leads', color: '#3a8f5c', fmt: v => v },
  { key: 'spend', label: 'Spend', color: '#6366f1', fmt: v => `$${(v || 0).toFixed(2)}` },
];

const CHART_PERIODS = [
  { key: '30',  label: '30D' },
  { key: '90',  label: '90D' },
  { key: '365', label: '1Y'  },
  { key: 'all', label: 'All' },
];

function CustomTooltip({ active, payload, label, metricKey }) {
  if (!active || !payload?.length) return null;
  const m = [...CHART_METRICS, ...MODAL_METRICS].find(x => x.key === metricKey);
  const val = payload[0]?.value;
  const display = m?.fmt ? m.fmt(val) : val;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{display}</div>
    </div>
  );
}

function SortArrow({ dir }) {
  return <span style={{ fontSize: 9, marginLeft: 3 }}>{dir === 'asc' ? '▲' : '▼'}</span>;
}

const AD_DETAIL_TABLE_COLS = [
  { key: 'campaign', label: 'Campaign'  },
  { key: 'adset',    label: 'Adset'     },
  { key: 'status',   label: 'Status'    },
  { key: 'spend',    label: 'Spend'     },
  { key: 'fbLeads',  label: 'FB Leads'  },
  { key: 'cpl',      label: 'Cost/Lead' },
  { key: 'cpm',      label: 'CPM'       },
  { key: 'ctr',      label: 'CTR'       },
  { key: 'clicks',   label: 'Clicks'    },
  { key: 'created',  label: 'Created'   },
];

// ── Ad Detail Modal ───────────────────────────────────────────────────────────
function fmtPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}

function AdDetailModal({ adName, state, allAds, sheetByName, accountLabel, mergeGroups, allAdDailyInsights, onSyncMax, onUnmerge, onClose }) {
  const [period, setPeriod]         = useState('90');
  const [sortKey, setSortKey]       = useState('spend');
  const [sortDir, setSortDir]       = useState('desc');
  const [modalMetric, setModalMetric] = useState('leads');
  const [caseSortKey, setCaseSortKey] = useState('date');
  const [caseSortDir, setCaseSortDir] = useState('desc');

  // GHL contacts + sheet cases — fetched on-demand when modal opens
  const [ghlContacts, setGhlContacts] = useState([]);
  const [sheetCases, setSheetCases]   = useState([]);
  const [loadingGhl, setLoadingGhl]   = useState(false);
  const [ghlError, setGhlError]       = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchData() {
      setLoadingGhl(true);
      setGhlError('');
      try {
        // Load cached GHL contacts first for instant display
        const cached = await dbGetAll('ghlContacts');
        if (!cancelled) setGhlContacts(cached);

        // Determine if GHL cache is stale (> 1 hour)
        const lastGhlSync = await dbGetMeta('lastGhlSync');
        const stale = !lastGhlSync || (Date.now() - new Date(lastGhlSync).getTime() > 3600 * 1000);

        const since = new Date(Date.now() - 2 * 365 * 864e5).toISOString();
        const now   = new Date().toISOString();

        const [freshGhl, sheetData] = await Promise.all([
          stale
            ? apiFetch(`/api/ghl/contacts?start=${encodeURIComponent(since)}&end=${encodeURIComponent(now)}`)
            : Promise.resolve(null),
          apiFetch('/api/sheets/cases'),
        ]);

        if (freshGhl && !cancelled) {
          await dbUpsert('ghlContacts', freshGhl);
          await dbSetMeta('lastGhlSync', now);
          const all = await dbGetAll('ghlContacts');
          if (!cancelled) setGhlContacts(all);
        }
        if (!cancelled) setSheetCases(sheetData);
      } catch (err) {
        if (!cancelled) setGhlError(err.message);
      } finally {
        if (!cancelled) setLoadingGhl(false);
      }
    }
    fetchData();
    return () => { cancelled = true; };
  }, []);

  function normalizePhone(p) {
    return (p || '').replace(/\D/g, '').slice(-10);
  }

  // Merge group this ad belongs to as canonical
  const mergeGroup = useMemo(() =>
    mergeGroups.find(g => g.canonical === adName),
    [mergeGroups, adName]
  );

  // All member names (for merged rows, includes canonical)
  const effectiveNames = useMemo(() =>
    mergeGroup ? mergeGroup.members : [adName],
    [mergeGroup, adName]
  );

  // FB instances: ads matching any effective name AND this state
  const fbInstances = useMemo(() =>
    allAds.filter(a =>
      effectiveNames.includes((a.name || '').trim()) &&
      extractState(a.campaignName) === state
    ),
    [allAds, effectiveNames, state]
  );

  // Unique adsets this ad has lived in
  const adsets = useMemo(() => {
    const seen = new Set();
    return fbInstances.filter(a => {
      if (seen.has(a.adsetId)) return false;
      seen.add(a.adsetId);
      return true;
    }).map(a => ({ id: a.adsetId, name: a.adsetName, campaign: a.campaignName }));
  }, [fbInstances]);

  // Build phone → GHL contact lookup (for UTM attribution)
  const ghlByPhone = useMemo(() => {
    const map = {};
    for (const c of ghlContacts) {
      const key = normalizePhone(c.phone);
      if (key) map[key] = c;
    }
    return map;
  }, [ghlContacts]);

  // Enrich sheet cases with UTM data — prefer already-written sheet values, fall back to GHL match
  const attributedCases = useMemo(() =>
    sheetCases
      .map(sc => {
        if (sc.utmContent) return sc;
        const contact = ghlByPhone[normalizePhone(sc.phone)];
        return contact
          ? { ...sc, utmContent: contact.utmContent, utmMedium: contact.utmMedium }
          : null;
      })
      .filter(Boolean),
    [sheetCases, ghlByPhone]
  );

  // Cases for this specific ad + state
  const cases = useMemo(() =>
    attributedCases.filter(c => {
      const an = (c.utmContent || '').toLowerCase().trim();
      const matchesAd    = effectiveNames.some(n => n.toLowerCase().trim() === an);
      const matchesState = (c.state || '').toUpperCase() === state;
      return matchesAd && matchesState;
    }),
    [attributedCases, effectiveNames, state]
  );

  const totalLeads = cases.length;

  // Use stored ad-level daily insights (populated by syncAdMax)
  const fbAdIds = useMemo(() => new Set(fbInstances.map(a => a.id).filter(Boolean)), [fbInstances]);

  const adDailyInsights = useMemo(() =>
    allAdDailyInsights.filter(r => fbAdIds.has(r.ad_id)),
    [allAdDailyInsights, fbAdIds]
  );

  const hasStoredSpend = adDailyInsights.length > 0;

  const cutoff = useMemo(() => {
    if (period === 'all') return null;
    return new Date(Date.now() - parseInt(period) * 864e5).toISOString().slice(0, 10);
  }, [period]);

  // Chart: GHL leads/day + FB ad-level spend/day
  const chartData = useMemo(() => {
    const leadsMap = {};
    for (const c of loadingGhl ? [] : cases) {
      if (!c.date) continue;
      const day = c.date.slice(0, 10);
      if (cutoff && day < cutoff) continue;
      leadsMap[day] = (leadsMap[day] || 0) + 1;
    }
    const spendMap = {};
    for (const row of adDailyInsights) {
      const date = row.date_start;
      if (!date || (cutoff && date < cutoff)) continue;
      spendMap[date] = (spendMap[date] || 0) + (parseFloat(row.spend) || 0);
    }
    const allDates = new Set([...Object.keys(leadsMap), ...Object.keys(spendMap)]);
    return [...allDates].sort().map(date => ({
      date:  date.slice(5),
      leads: leadsMap[date] || 0,
      spend: +(spendMap[date] || 0).toFixed(2),
    }));
  }, [cases, adDailyInsights, cutoff]);

  // Table rows: one per FB ad instance
  const tableRows = useMemo(() =>
    fbInstances.map(a => ({
      id:      a.id,
      adName:  (a.name || '').trim(),
      campaign: a.campaignName || '—',
      adset:    a.adsetName    || '—',
      status:   a.status       || '—',
      spend:    parseFloat(a.spend)  || 0,
      fbLeads:  a.results            || 0,
      cpl:      a.results > 0 && parseFloat(a.spend) > 0
                  ? parseFloat((parseFloat(a.spend) / a.results).toFixed(2))
                  : null,
      cpm:     parseFloat(a.cpm)   || 0,
      ctr:     parseFloat(a.ctr)   || 0,
      clicks:  parseInt(a.clicks)  || 0,
      created: a.createdTime        || '',
    })),
    [fbInstances]
  );

  const sortedRows = useMemo(() => {
    return [...tableRows].sort((a, b) => {
      const av = a[sortKey] ?? '', bv = b[sortKey] ?? '';
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }, [tableRows, sortKey, sortDir]);

  const totals = useMemo(() => ({
    spend:   tableRows.reduce((s, r) => s + r.spend,   0),
    fbLeads: tableRows.reduce((s, r) => s + r.fbLeads, 0),
    clicks:  tableRows.reduce((s, r) => s + r.clicks,  0),
  }), [tableRows]);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function fmtCell(key, val) {
    if (val == null) return '—';
    if (key === 'spend' || key === 'cpl' || key === 'cpm') return `$${val.toFixed(2)}`;
    if (key === 'ctr') return `${val.toFixed(2)}%`;
    if (key === 'created') return fmtDate(val);
    if (key === 'status') return (
      <span style={{ color: val === 'ACTIVE' ? '#22c55e' : '#94a3b8', fontSize: 11, fontWeight: 600 }}>{val}</span>
    );
    return val;
  }

  const activeModalMetric = MODAL_METRICS.find(m => m.key === modalMetric);

  return (
    <div className="ad-detail-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ad-detail-panel">
        {/* Header */}
        <div className="col-mgr-head">
          <div>
            <div className="col-mgr-title">{adName}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {accountLabel(state)} ({state}) · {totalLeads} cases
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {mergeGroup && (
              <button
                className="btn btn--sm"
                style={{ color: '#dc2626' }}
                onClick={() => onUnmerge(adName)}
                title="Split back into individual rows"
              >
                Unmerge
              </button>
            )}
            <button className="col-mgr-x" onClick={onClose}>×</button>
          </div>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '0 20px 24px' }}>

          {/* Combined members */}
          {mergeGroup && (
            <div style={{ marginTop: 14, marginBottom: 16, padding: '10px 14px', background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Combined ads ({mergeGroup.members.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {mergeGroup.members.map(m => (
                  <span key={m} style={{
                    fontSize: 12,
                    background: m === adName ? '#d1fae5' : 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: 5,
                    padding: '2px 8px',
                    color: m === adName ? '#065f46' : 'var(--text)',
                    fontWeight: m === adName ? 600 : 400,
                  }}>
                    {m}{m === adName ? ' (canonical)' : ''}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Adsets */}
          {adsets.length > 0 && (
            <div style={{ marginTop: 14, marginBottom: 18 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
                Adsets ({adsets.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {adsets.map(as => (
                  <div key={as.id} style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 12 }}>
                    <span style={{ fontWeight: 600 }}>{as.name || 'Unknown'}</span>
                    {as.campaign && <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: 11 }}>{as.campaign}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Per-ad chart */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {MODAL_METRICS.map(m => (
                  <button
                    key={m.key}
                    className={`btn btn--sm${modalMetric === m.key ? ' btn--primary' : ''}`}
                    onClick={() => setModalMetric(m.key)}
                    disabled={m.key === 'spend' && !hasStoredSpend}
                    title={m.key === 'spend' && !hasStoredSpend ? 'Use Sync Max to pull spend data for this ad' : undefined}
                  >
                    {m.label}
                  </button>
                ))}
                {!hasStoredSpend && (
                  <button
                    className="btn btn--sm"
                    style={{ marginLeft: 4 }}
                    onClick={() => onSyncMax([adName])}
                    title="Pull all-time daily spend data for this ad"
                  >
                    Sync Max
                  </button>
                )}
                {hasStoredSpend && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>
                    {adDailyInsights.length} daily rows
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                {CHART_PERIODS.map(p => (
                  <button key={p.key} className={`btn btn--sm${period === p.key ? ' btn--primary' : ''}`} onClick={() => setPeriod(p.key)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)', padding: '16px 8px 8px' }}>
              {chartData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-muted)', fontSize: 13 }}>
                  {modalMetric === 'spend' && !hasStoredSpend
                    ? 'Click "Sync Max" above to pull spend data for this ad'
                    : 'No data in this period'}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chartData} margin={{ top: 4, right: 20, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} />
                    <Tooltip content={<CustomTooltip metricKey={modalMetric} />} />
                    <Line type="linear" dataKey={modalMetric} stroke={activeModalMetric?.color || '#3a8f5c'} dot={false} strokeWidth={2} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* FB Instances table */}
          {fbInstances.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
                FB Ad Instances ({fbInstances.length})
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="tracking-grid" style={{ minWidth: 900 }}>
                  <thead>
                    <tr>
                      {mergeGroup && <th className="tracking-th-state" style={{ whiteSpace: 'nowrap' }}>Ad Name</th>}
                      {AD_DETAIL_TABLE_COLS.map(col => (
                        <th
                          key={col.key}
                          className="tracking-th-state tracking-th-sortable"
                          onClick={() => handleSort(col.key)}
                          style={{ whiteSpace: 'nowrap', cursor: 'pointer' }}
                        >
                          {col.label}
                          {sortKey === col.key && <SortArrow dir={sortDir} />}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map(row => (
                      <tr key={row.id}>
                        {mergeGroup && (
                          <td className="tracking-td-cell" style={{ fontSize: 11, maxWidth: 160, whiteSpace: 'normal' }}>
                            {row.adName}
                          </td>
                        )}
                        {AD_DETAIL_TABLE_COLS.map(col => (
                          <td key={col.key} className="tracking-td-cell" style={{
                            whiteSpace: (col.key === 'campaign' || col.key === 'adset') ? 'normal' : 'nowrap',
                            maxWidth: (col.key === 'campaign' || col.key === 'adset') ? 200 : undefined,
                          }}>
                            {fmtCell(col.key, row[col.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      {mergeGroup && <td className="tracking-tfoot-label" />}
                      <td className="tracking-tfoot-label" colSpan={3}>Total</td>
                      <td className="tracking-td-total tracking-tfoot-label">${totals.spend.toFixed(2)}</td>
                      <td className="tracking-td-total tracking-tfoot-label">{totals.fbLeads}</td>
                      <td className="tracking-td-total tracking-tfoot-label">
                        {totals.fbLeads > 0 && totals.spend > 0 ? `$${(totals.spend / totals.fbLeads).toFixed(2)}` : '—'}
                      </td>
                      <td className="tracking-tfoot-label" />
                      <td className="tracking-tfoot-label" />
                      <td className="tracking-td-total tracking-tfoot-label">{totals.clicks}</td>
                      <td className="tracking-tfoot-label" />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {/* GHL Leads list with delete */}
          {loadingGhl && ghlContacts.length === 0 && (
            <div style={{ padding: '16px 0', fontSize: 12, color: 'var(--text-muted)' }}>Loading cases…</div>
          )}
          {ghlError && (
            <div style={{ padding: '8px 12px', fontSize: 12, color: '#dc2626', background: '#fee2e2', borderRadius: 6, marginTop: 8 }}>{ghlError}</div>
          )}
          {cases.length > 0 && (() => {
            const CASE_COLS = [
              { key: 'date',  label: 'Date'  },
              { key: 'name',  label: 'Name'  },
              { key: 'phone', label: 'Phone' },
            ];
            const sorted = [...cases].sort((a, b) => {
              const av = a[caseSortKey] || '', bv = b[caseSortKey] || '';
              if (av < bv) return caseSortDir === 'asc' ? -1 : 1;
              if (av > bv) return caseSortDir === 'asc' ?  1 : -1;
              return 0;
            });
            function handleCaseSort(key) {
              if (caseSortKey === key) setCaseSortDir(d => d === 'asc' ? 'desc' : 'asc');
              else { setCaseSortKey(key); setCaseSortDir(key === 'date' ? 'desc' : 'asc'); }
            }
            return (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: 8 }}>
                  Cases ({cases.length})
                  {loadingGhl && <span style={{ fontWeight: 400, marginLeft: 8, textTransform: 'none' }}>refreshing…</span>}
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="tracking-grid" style={{ minWidth: 560 }}>
                    <thead>
                      <tr>
                        {CASE_COLS.map(col => (
                          <th
                            key={col.key}
                            className="tracking-th-state tracking-th-sortable"
                            onClick={() => handleCaseSort(col.key)}
                            style={{ whiteSpace: 'nowrap', cursor: 'pointer', textAlign: 'left' }}
                          >
                            {col.label}{caseSortKey === col.key && <SortArrow dir={caseSortDir} />}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((c, i) => (
                        <tr key={c.phone + i} className="tracking-row">
                          <td className="tracking-td-cell" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                            {c.date ? fmtDate(c.date) : '—'}
                          </td>
                          <td className="tracking-td-cell" style={{ fontWeight: 500 }}>
                            {c.name || '—'}
                          </td>
                          <td className="tracking-td-cell" style={{ fontSize: 12 }}>
                            {fmtPhone(c.phone) || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}

          {fbInstances.length === 0 && cases.length === 0 && (
            <div className="empty" style={{ padding: 48 }}>No data found for this ad</div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function AdsTracking() {
  // Persistent data
  const [allDailyInsights, setAllDailyInsights] = useState([]);
  const [allAds, setAllAds]                     = useState([]);
  const [lastSync, setLastSync]                 = useState(null);

  // Row management
  const [deletedAds, setDeletedAds]   = useState(new Set());  // hidden ad names
  const [mergeGroups, setMergeGroups] = useState([]);          // [{canonical, members}]

  // Ad-level daily insights (selectively synced)
  const [allAdDailyInsights, setAllAdDailyInsights] = useState([]);
  const [syncingAdMax, setSyncingAdMax]             = useState(false);
  const [adMaxNote, setAdMaxNote]                   = useState('');


  // Sync
  const [syncing, setSyncing]     = useState(false);
  const [syncNote, setSyncNote]   = useState('');
  const [syncError, setSyncError] = useState('');
  const syncingRef = useRef(false);

  // UI
  const [accountNames, setAccountNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trackingAccountNames') || '{}'); }
    catch { return {}; }
  });
  const [editingState, setEditingState] = useState(null);
  const [editValue, setEditValue]       = useState('');
  const [adDetail, setAdDetail]         = useState(null);   // { adName, state }
  const [chartMetric, setChartMetric]   = useState('leads');
  const [chartPeriod, setChartPeriod]   = useState('90');
  const [sortKey, setSortKey]           = useState('date');
  const [sortDir, setSortDir]           = useState('desc');
  // Custom date range for the grid
  const [rangeStart, setRangeStart]     = useState('');
  const [rangeEnd, setRangeEnd]         = useState('');
  const [rangeAds, setRangeAds]         = useState(null);   // null = use allAds
  const [loadingRange, setLoadingRange] = useState(false);
  const [rangeError, setRangeError]     = useState('');
  const [colOrder, setColOrder]         = useState(null);
  const [dragOverCol, setDragOverCol]   = useState(null);
  const dragColRef = useRef(null);

  // Resizable columns / rows
  const [colWidths, setColWidths]   = useState({});
  const [rowHeights, setRowHeights] = useState({});

  // Cases data (loaded on mount)
  const [ghlContacts, setGhlContacts] = useState([]);
  const [sheetCases, setSheetCases]   = useState([]);
  const [loadingCases, setLoadingCases] = useState(false);
  const [casesError, setCasesError]   = useState('');
  const casesLoadedRef = useRef(false);

  const [importing, setImporting]         = useState(false);
  const [importResult, setImportResult]   = useState(null); // { added, skipped }
  const [importError, setImportError]     = useState('');
  const importRanRef = useRef(false);

  // Row selection / merge
  const [selecting, setSelecting]     = useState(false);
  const [selectedRows, setSelectedRows] = useState(new Set());
  const [mergeDialog, setMergeDialog]   = useState(null); // { names, canonical }

  // ── Derived merge maps ──────────────────────────────────────────────────────
  const memberToCanonical = useMemo(() => {
    const map = {};
    for (const g of mergeGroups) for (const m of g.members) map[m] = g.canonical;
    return map;
  }, [mergeGroups]);

  const absorbedMembers = useMemo(() => {
    const set = new Set();
    for (const g of mergeGroups)
      for (const m of g.members)
        if (m !== g.canonical) set.add(m);
    return set;
  }, [mergeGroups]);

  // Fetch ads for custom date range; clear rangeAds when range is cleared
  useEffect(() => {
    if (!rangeStart || !rangeEnd || rangeStart > rangeEnd) {
      setRangeAds(null);
      setRangeError('');
      return;
    }
    let cancelled = false;
    setLoadingRange(true);
    setRangeError('');
    apiFetch(`/api/facebook/ads?start=${rangeStart}&end=${rangeEnd}`)
      .then(data => { if (!cancelled) { setRangeAds(data); setLoadingRange(false); } })
      .catch(err  => { if (!cancelled) { setRangeError(err.message); setLoadingRange(false); } });
    return () => { cancelled = true; };
  }, [rangeStart, rangeEnd]);

  // Active ads: use rangeAds when a custom range is set, otherwise all-time allAds
  const activeAds = rangeAds ?? allAds;

  // ── Load from IndexedDB ─────────────────────────────────────────────────────
  async function loadFromDB() {
    const [insights, ads, adDaily, syncTime, deleted, merges] = await Promise.all([
      dbGetAll('fbDailyInsights'),
      dbGetAll('fbAds'),
      dbGetAll('adDailyInsights'),
      dbGetMeta('lastSync'),
      dbGetMeta('deletedAds'),
      dbGetMeta('mergeGroups'),
    ]);
    setAllDailyInsights(insights);
    setAllAds(ads);
    setAllAdDailyInsights(adDaily);
    setLastSync(syncTime);
    setDeletedAds(new Set(deleted || []));
    setMergeGroups(merges || []);
  }

  // ── Cases fetch (lazy, on first toggle to Cases view) ───────────────────────
  async function loadCases() {
    if (casesLoadedRef.current) return;
    casesLoadedRef.current = true;
    setLoadingCases(true);
    setCasesError('');
    try {
      const cached = await dbGetAll('ghlContacts');
      setGhlContacts(cached);

      const lastGhlSync = await dbGetMeta('lastGhlSync');
      const stale = !lastGhlSync || (Date.now() - new Date(lastGhlSync).getTime() > 3600 * 1000);
      const since = new Date(Date.now() - 2 * 365 * 864e5).toISOString();
      const now   = new Date().toISOString();

      const [freshGhl, sheetData] = await Promise.all([
        stale ? apiFetch(`/api/ghl/contacts?start=${encodeURIComponent(since)}&end=${encodeURIComponent(now)}`) : Promise.resolve(null),
        apiFetch('/api/sheets/cases'),
      ]);

      if (freshGhl) {
        await dbUpsert('ghlContacts', freshGhl);
        await dbSetMeta('lastGhlSync', now);
        const all = await dbGetAll('ghlContacts');
        setGhlContacts(all);
      }
      setSheetCases(sheetData);
    } catch (err) {
      setCasesError(err.message);
      casesLoadedRef.current = false; // allow retry
    } finally {
      setLoadingCases(false);
    }
  }

  useEffect(() => { loadCases(); }, []);

  // ── Monthly sheet import ─────────────────────────────────────────────────────
  async function importMonth() {
    if (importing) return;
    setImporting(true);
    setImportError('');
    setImportResult(null);
    try {
      const res = await fetch(`${BASE}/api/sheets/import-month`, { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || res.statusText);
      setImportResult(json);
      // Reload cases so new rows appear immediately
      casesLoadedRef.current = false;
      await loadCases();
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }

  // Auto-run import once on mount (after cases load)
  useEffect(() => {
    if (importRanRef.current) return;
    importRanRef.current = true;
    importMonth();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── FB sync ─────────────────────────────────────────────────────────────────
  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError('');
    setSyncNote('Starting sync…');
    try {
      const lastSyncTime = await dbGetMeta('lastSync');
      const isFirstSync  = !lastSyncTime;
      const now          = new Date().toISOString();

      setSyncNote('Fetching ads…');
      const ads = await apiFetch('/api/facebook/ads?date_preset=maximum');
      await dbUpsert('fbAds', ads);

      setSyncNote('Fetching daily insights…');
      const preset     = isFirstSync ? 'maximum' : 'last_14d';
      const dailyRaw   = await apiFetch(`/api/facebook/daily?date_preset=${preset}`);
      const dailyRecords = dailyRaw.map(r => ({
        ...r,
        id: `${r.date_start}|${r.campaign_id || r.adset_id || r.ad_id || 'agg'}`,
      }));
      await dbUpsert('fbDailyInsights', dailyRecords);

      await dbSetMeta('lastSync', now);
      await loadFromDB();
      setSyncNote('Done');
    } catch (err) {
      console.error('Sync error:', err);
      setSyncError(err.message);
      setSyncNote('');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // On mount: load cache, sync FB if stale
  useEffect(() => {
    dbClearStore('sheetImport').catch(() => {});
    dbSetMeta('trackingColumns', null).catch(() => {});
    loadFromDB().then(async () => {
      const ts    = await dbGetMeta('lastSync');
      const stale = !ts || (Date.now() - new Date(ts).getTime() > 6 * 3600 * 1000);
      if (stale) sync();
    });
  }, []);

  async function resetData() {
    if (!window.confirm('Clear all stored tracking data and re-sync from scratch?')) return;
    await dbClearAll();
    setAllDailyInsights([]);
    setAllAds([]);
    setGhlContacts([]);
    setSheetCases([]);
    setLastSync(null);
    setSyncNote('');
    setSyncError('');
    casesLoadedRef.current = false;
    importRanRef.current = false;
    sync();
    loadCases();
  }

  // ── Delete an ad permanently ────────────────────────────────────────────────
  async function deleteAd(adName) {
    if (!window.confirm(`Hide "${adName}" from the grid permanently?\n\nYou can restore it later by clearing tracking data.`)) return;
    const next = new Set(deletedAds);
    next.add(adName);
    setDeletedAds(next);
    await dbSetMeta('deletedAds', [...next]);
  }

  // ── Merge selected rows ─────────────────────────────────────────────────────
  function openMergeDialog() {
    const names = [...selectedRows];
    setMergeDialog({ names, canonical: names[0] });
  }

  async function confirmMerge() {
    const { names, canonical } = mergeDialog;
    if (!canonical || !names.includes(canonical)) return;
    // Remove any existing groups that overlap these names
    const filtered = mergeGroups.filter(g => !g.members.some(m => names.includes(m)));
    const next = [...filtered, { canonical, members: names }];
    setMergeGroups(next);
    await dbSetMeta('mergeGroups', next);
    setMergeDialog(null);
    setSelectedRows(new Set());
    setSelecting(false);
  }

  async function unmergeGroup(canonical) {
    const next = mergeGroups.filter(g => g.canonical !== canonical);
    setMergeGroups(next);
    await dbSetMeta('mergeGroups', next);
  }

  // Sync all-time ad-level daily data for specific ad names (selective API pull)
  async function syncAdMax(adNamesList) {
    if (syncingAdMax) return;
    setSyncingAdMax(true);
    setAdMaxNote('');
    try {
      // Resolve all effective names (including merged members)
      const effectiveNames = new Set();
      for (const name of adNamesList) {
        effectiveNames.add(name);
        const group = mergeGroups.find(g => g.canonical === name);
        if (group) group.members.forEach(m => effectiveNames.add(m));
      }
      // Find FB ad IDs for these names
      const adIds = allAds
        .filter(a => effectiveNames.has((a.name || '').trim()))
        .map(a => a.id)
        .filter(Boolean);
      if (!adIds.length) {
        setAdMaxNote('No FB ad IDs found — run Sync Now first to load ads');
        return;
      }
      setAdMaxNote(`Fetching ${adIds.length} ad IDs across accounts…`);
      const data = await apiFetch(
        `/api/facebook/daily?date_preset=maximum&ad_ids=${encodeURIComponent(adIds.join(','))}`
      );
      const records = data.map(r => ({ ...r, id: `${r.date_start}|${r.ad_id}` }));
      await dbUpsert('adDailyInsights', records);
      const all = await dbGetAll('adDailyInsights');
      setAllAdDailyInsights(all);
      setAdMaxNote(`Synced ${adNamesList.length} ad${adNamesList.length !== 1 ? 's' : ''} · ${records.length} daily rows`);
      setSelectedRows(new Set());
      setSelecting(false);
    } catch (err) {
      setAdMaxNote(`Sync failed: ${err.message.slice(0, 80)}`);
    } finally {
      setSyncingAdMax(false);
    }
  }

  function toggleRowSelect(adName) {
    setSelectedRows(prev => {
      const next = new Set(prev);
      if (next.has(adName)) next.delete(adName);
      else next.add(adName);
      return next;
    });
  }

  // ── Derived data ────────────────────────────────────────────────────────────
  const states = useMemo(() => {
    const set = new Set();
    for (const a of activeAds) {
      const s = extractState(a.campaignName);
      if (s) set.add(s);
    }
    return [...set].sort();
  }, [activeAds]);

  const orderedStates = useMemo(() => {
    if (!colOrder) return states;
    const existing = colOrder.filter(s => states.includes(s));
    const newOnes  = states.filter(s => !colOrder.includes(s));
    return [...existing, ...newOnes];
  }, [states, colOrder]);

  // Ad names: from FB ads only, excluding deleted and absorbed members
  const adNames = useMemo(() => {
    const seen  = new Set();
    const names = [];
    for (const a of activeAds) {
      const name = (a.name || '').trim();
      if (name && !seen.has(name) && !deletedAds.has(name) && !absorbedMembers.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }, [activeAds, deletedAds, absorbedMembers]);

  const sheetByName = {};

  // Grid: FB results (leads) per ad per state
  const grid = useMemo(() => {
    const map = {};
    for (const adName of adNames) {
      map[adName] = {};
      for (const state of states) map[adName][state] = 0;
    }
    for (const a of activeAds) {
      const rawName = (a.name || '').trim();
      const state   = extractState(a.campaignName);
      if (!rawName || !state || deletedAds.has(rawName)) continue;
      const adName  = memberToCanonical[rawName] || rawName;
      if (map[adName]?.[state] !== undefined) {
        map[adName][state] += a.results || 0;
      }
    }
    return map;
  }, [adNames, states, activeAds, deletedAds, memberToCanonical]);

  // ── Cases grid (sheet cases attributed via GHL UTM) ────────────────────────
  const ghlByPhone = useMemo(() => {
    const map = {};
    for (const c of ghlContacts) {
      const key = (c.phone || '').replace(/\D/g, '').slice(-10);
      if (key) map[key] = c;
    }
    return map;
  }, [ghlContacts]);

  // Write GHL UTM data to sheet for rows that don't have column I populated yet
  useEffect(() => {
    if (!ghlContacts.length || !sheetCases.length) return;
    const toEnrich = sheetCases
      .map(sc => {
        const key = (sc.phone || '').replace(/\D/g, '').slice(-10);
        const contact = ghlByPhone[key];
        return contact ? { rowIndex: sc.rowIndex, utmCampaign: contact.utmCampaign, utmAdset: contact.utmAdset, utmContent: contact.utmContent, utmTerm: contact.utmTerm } : null;
      })
      .filter(Boolean);
    if (!toEnrich.length) return;
    fetch(`${BASE}/api/sheets/enrich-utm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toEnrich),
    }).catch(err => console.warn('UTM enrich error:', err.message));
  }, [ghlContacts, sheetCases]); // eslint-disable-line react-hooks/exhaustive-deps

  // Match cases from column I (ad name) — populated by sheet or just-enriched GHL data
  const attributedCases = useMemo(() =>
    sheetCases
      .map(sc => {
        if (sc.utmContent) return sc;
        // Fall back to GHL match for rows not yet written to sheet
        const key = (sc.phone || '').replace(/\D/g, '').slice(-10);
        const contact = ghlByPhone[key];
        return contact ? { ...sc, utmContent: contact.utmContent } : null;
      })
      .filter(sc => sc?.utmContent),
    [sheetCases, ghlByPhone]
  );

  const caseGrid = useMemo(() => {
    const map = {};
    for (const adName of adNames) {
      map[adName] = {};
      for (const st of states) map[adName][st] = 0;
    }
    for (const c of attributedCases) {
      const rawAdName = (c.utmContent || '').trim();
      const canonical = memberToCanonical[rawAdName] || rawAdName;
      const st = (c.state || '').toUpperCase();
      if (map[canonical]?.[st] !== undefined) {
        map[canonical][st]++;
      }
    }
    return map;
  }, [adNames, states, attributedCases, memberToCanonical]);

  // Spend per ad per state
  const spendGrid = useMemo(() => {
    const map = {};
    for (const adName of adNames) {
      map[adName] = {};
      for (const st of states) map[adName][st] = 0;
    }
    for (const a of activeAds) {
      const rawName = (a.name || '').trim();
      const st      = extractState(a.campaignName);
      if (!rawName || !st || deletedAds.has(rawName)) continue;
      const adName  = memberToCanonical[rawName] || rawName;
      if (map[adName]?.[st] !== undefined) {
        map[adName][st] += parseFloat(a.spend) || 0;
      }
    }
    return map;
  }, [adNames, states, activeAds, deletedAds, memberToCanonical]);

  // Adset sizes: how many ads are in each adset (across all states)
  const adsetSizes = useMemo(() => {
    const map = {};
    for (const a of activeAds) {
      if (a.adsetId) map[a.adsetId] = (map[a.adsetId] || 0) + 1;
    }
    return map;
  }, [activeAds]);

  // Cell status per adName × state: 'solo' (green) | 'shared' (blue) | 'off' (none)
  const cellStatus = useMemo(() => {
    const map = {};
    for (const adName of adNames) {
      map[adName] = {};
      for (const st of states) {
        const instances = activeAds.filter(a => {
          const canonical = memberToCanonical[(a.name || '').trim()] || (a.name || '').trim();
          return canonical === adName && extractState(a.campaignName) === st;
        });
        const active = instances.filter(a => a.status === 'ACTIVE');
        if (!active.length) { map[adName][st] = 'off'; continue; }
        const hasSolo = active.some(a => (adsetSizes[a.adsetId] || 1) === 1);
        map[adName][st] = hasSolo ? 'solo' : 'shared';
      }
    }
    return map;
  }, [adNames, states, activeAds, memberToCanonical, adsetSizes]);

  // First used: earliest date among all members' ad names
  const firstUsed = useMemo(() => {
    const map = {};
    const toCheck = new Set([...adNames, ...mergeGroups.flatMap(g => g.members)]);
    for (const rawName of toCheck) {
      const iso = parseAdNameDate(rawName);
      if (!iso) continue;
      const canonical = memberToCanonical[rawName] || rawName;
      if (!map[canonical] || iso < map[canonical]) map[canonical] = iso;
    }
    return map;
  }, [adNames, mergeGroups, memberToCanonical]);

  const sortedAdNames = useMemo(() => {
    return [...adNames].sort((a, b) => {
      // Ads with no date always sink to the bottom regardless of sort direction
      if (sortKey === 'date') {
        const aHas = !!firstUsed[a], bHas = !!firstUsed[b];
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        if (!aHas && !bHas) return 0;
        const av = firstUsed[a], bv = firstUsed[b];
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ?  1 : -1;
        return 0;
      }
      let av, bv;
      if (sortKey === 'name') {
        av = a.toLowerCase(); bv = b.toLowerCase();
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ?  1 : -1;
        return 0;
      } else if (sortKey === 'spend') {
        av = states.reduce((s, st) => s + (spendGrid[a]?.[st] || 0), 0);
        bv = states.reduce((s, st) => s + (spendGrid[b]?.[st] || 0), 0);
      } else if (sortKey === 'cpl') {
        const aLeads = states.reduce((s, st) => s + (grid[a]?.[st] || 0), 0);
        const bLeads = states.reduce((s, st) => s + (grid[b]?.[st] || 0), 0);
        const aSpend = states.reduce((s, st) => s + (spendGrid[a]?.[st] || 0), 0);
        const bSpend = states.reduce((s, st) => s + (spendGrid[b]?.[st] || 0), 0);
        av = aLeads > 0 ? aSpend / aLeads : Infinity;
        bv = bLeads > 0 ? bSpend / bLeads : Infinity;
      } else if (sortKey === 'cpc') {
        const aCases = states.reduce((s, st) => s + (caseGrid[a]?.[st] || 0), 0);
        const bCases = states.reduce((s, st) => s + (caseGrid[b]?.[st] || 0), 0);
        const aSpend = states.reduce((s, st) => s + (spendGrid[a]?.[st] || 0), 0);
        const bSpend = states.reduce((s, st) => s + (spendGrid[b]?.[st] || 0), 0);
        av = aCases > 0 ? aSpend / aCases : Infinity;
        bv = bCases > 0 ? bSpend / bCases : Infinity;
      } else if (sortKey === 'total') {
        av = states.reduce((s, st) => s + (grid[a]?.[st] || 0), 0);
        bv = states.reduce((s, st) => s + (grid[b]?.[st] || 0), 0);
      } else if (sortKey === 'totalCases') {
        av = states.reduce((s, st) => s + (caseGrid[a]?.[st] || 0), 0);
        bv = states.reduce((s, st) => s + (caseGrid[b]?.[st] || 0), 0);
      } else {
        av = grid[a]?.[sortKey] || 0;
        bv = grid[b]?.[sortKey] || 0;
      }
      // Zeros always sink to the bottom regardless of sort direction
      const aZero = av === 0 || av === Infinity;
      const bZero = bv === 0 || bv === Infinity;
      if (aZero && !bZero) return 1;
      if (!aZero && bZero) return -1;
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ?  1 : -1;
      return 0;
    });
  }, [adNames, sortKey, sortDir, grid, caseGrid, spendGrid, firstUsed, states]);

  function startColResize(key, defaultW, e) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX, startW = colWidths[key] ?? defaultW;
    const onMove = ev => setColWidths(p => ({ ...p, [key]: Math.max(40, startW + ev.clientX - startX) }));
    const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startRowResize(adName, e) {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY, startH = rowHeights[adName] ?? 36;
    const onMove = ev => setRowHeights(p => ({ ...p, [adName]: Math.max(28, startH + ev.clientY - startY) }));
    const onUp   = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  }

  function onColDragStart(i) { dragColRef.current = i; }
  function onColDragOver(e, i) { e.preventDefault(); setDragOverCol(i); }
  function onColDrop(i) {
    if (dragColRef.current === null || dragColRef.current === i) {
      dragColRef.current = null; setDragOverCol(null); return;
    }
    const next = [...orderedStates];
    const [moved] = next.splice(dragColRef.current, 1);
    next.splice(i, 0, moved);
    setColOrder(next);
    dragColRef.current = null; setDragOverCol(null);
  }

  const cutoffDate = useMemo(() => {
    if (chartPeriod === 'all') return null;
    return new Date(Date.now() - parseInt(chartPeriod) * 864e5).toISOString().slice(0, 10);
  }, [chartPeriod]);

  const chartData = useMemo(() => {
    const LEAD_TYPES = ['lead','onsite_conversion.lead_grouped','offsite_conversion.fb_pixel_lead','contact','schedule','submit_application'];
    function actionsLeads(actions = []) {
      for (const type of LEAD_TYPES) {
        const a = actions.find(x => x.action_type === type);
        if (a) return parseInt(a.value, 10) || 0;
      }
      return 0;
    }
    const fbMap = {};
    for (const row of allDailyInsights) {
      const date = row.date_start;
      if (!date || (cutoffDate && date < cutoffDate)) continue;
      if (!fbMap[date]) fbMap[date] = { spend: 0, leads: 0, cpm_sum: 0, cpm_count: 0 };
      fbMap[date].spend += parseFloat(row.spend) || 0;
      fbMap[date].leads += actionsLeads(row.actions || []);
      if (row.cpm) { fbMap[date].cpm_sum += parseFloat(row.cpm); fbMap[date].cpm_count++; }
    }
    return Object.keys(fbMap).sort().map(date => {
      const fb    = fbMap[date];
      const leads = fb.leads;
      const spend = +(fb.spend).toFixed(2);
      const cpm   = fb.cpm_count > 0 ? +(fb.cpm_sum / fb.cpm_count).toFixed(2) : null;
      const cpl   = leads > 0 && spend > 0 ? +(spend / leads).toFixed(2) : null;
      return { date: date.slice(5), leads, spend, cpm, cpl };
    });
  }, [allDailyInsights, cutoffDate]);


  function saveAccountName(state, name) {
    const next = { ...accountNames, [state]: name.trim() || state };
    setAccountNames(next);
    localStorage.setItem('trackingAccountNames', JSON.stringify(next));
    setEditingState(null);
  }

  function accountLabel(state) {
    return accountNames[state] || state;
  }

  const activeMetric = CHART_METRICS.find(m => m.key === chartMetric);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div className="tab-title">Ads Tracking</div>
          <div className="tab-desc">Cumulative all-time leads per ad per account</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Last synced: {lastSync ? timeAgo(lastSync) : 'never'}
            </span>
            <button className="btn btn--sm btn--primary" onClick={sync} disabled={syncing}>
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
            <button className="btn btn--sm" onClick={resetData} disabled={syncing} title="Clear all stored data and re-sync">
              Reset
            </button>
          </div>
          {syncing && syncNote && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{syncNote}</span>
          )}
          {!syncing && syncNote && !syncError && (
            <span style={{ fontSize: 11, color: 'var(--green-dark)' }}>{syncNote}</span>
          )}
          {syncError && (
            <span style={{ fontSize: 11, color: '#dc2626' }} title={syncError}>
              Sync failed — {syncError.slice(0, 80)}
            </span>
          )}
        </div>
      </div>

      {/* Charts */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {CHART_METRICS.map(m => (
              <button key={m.key} className={`btn btn--sm${chartMetric === m.key ? ' btn--primary' : ''}`} onClick={() => setChartMetric(m.key)}>
                {m.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center', flexWrap: 'wrap' }}>
            {CHART_PERIODS.map(p => (
              <button key={p.key} className={`btn btn--sm${chartPeriod === p.key ? ' btn--primary' : ''}`} onClick={() => setChartPeriod(p.key)}>
                {p.label}
              </button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>|</span>
            <input
              type="date"
              value={rangeStart}
              onChange={e => setRangeStart(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }}
              placeholder="Start"
            />
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
            <input
              type="date"
              value={rangeEnd}
              onChange={e => setRangeEnd(e.target.value)}
              style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 12 }}
              placeholder="End"
            />
            {(rangeStart || rangeEnd) && (
              <button className="btn btn--sm" onClick={() => { setRangeStart(''); setRangeEnd(''); }} title="Clear date range">✕</button>
            )}
            {loadingRange && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading…</span>}
            {rangeError  && <span style={{ fontSize: 11, color: '#dc2626' }} title={rangeError}>Range error</span>}
          </div>
        </div>
        <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '20px 8px 8px' }}>
          {chartData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              {syncing ? 'Loading data…' : 'No data yet — click Sync Now'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <Tooltip content={<CustomTooltip metricKey={chartMetric} />} />
                <Line type="linear" dataKey={chartMetric} stroke={activeMetric?.color || '#3a8f5c'} dot={false} strokeWidth={2} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Grid stats */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {adNames.length} unique ads
          {deletedAds.size > 0 && ` · ${deletedAds.size} hidden`}
          {rangeAds && ` · ${rangeStart} – ${rangeEnd}`}
        </span>
        {loadingCases && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Loading cases…</span>}
        {casesError && <span style={{ fontSize: 11, color: '#dc2626' }}>{casesError}</span>}
        {importing && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Importing monthly cases…</span>}
        {!importing && importResult && (
          <span style={{ fontSize: 11, color: 'var(--green-dark)' }}>
            Imported: +{importResult.added} new · {importResult.skipped} already present
          </span>
        )}
        {importError && (
          <span style={{ fontSize: 11, color: '#dc2626' }} title={importError}>
            Import failed — {importError.slice(0, 60)}
          </span>
        )}
        <button
          className="btn btn--sm"
          onClick={importMonth}
          disabled={importing}
          title="Import current month's cases into the master sheet"
        >
          {importing ? 'Importing…' : 'Import Month'}
        </button>
        <button
          className={`btn btn--sm${selecting ? ' btn--primary' : ''}`}
          style={{ marginLeft: 'auto' }}
          onClick={() => { setSelecting(s => !s); setSelectedRows(new Set()); }}
        >
          {selecting ? 'Cancel Select' : 'Select Rows'}
        </button>
      </div>

      {adNames.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📊</div>
          <div className="empty-title">{syncing || loadingRange ? 'Loading…' : 'No data yet'}</div>
          <div className="empty-desc">
            {syncing ? 'This may take a moment on first sync.' : loadingRange ? 'Fetching date range…' : 'Click "Sync Now" to load your ads and leads.'}
          </div>
        </div>
      ) : (
        <div className="tracking-grid-wrap">
          <table className="tracking-grid" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              {selecting && <col style={{ width: 32 }} />}
              <col style={{ width: colWidths.adName ?? 240 }} />
              <col style={{ width: colWidths.date  ?? 90 }} />
              <col style={{ width: colWidths.spend ?? 80 }} />
              <col style={{ width: colWidths.cpl   ?? 70 }} />
              <col style={{ width: colWidths.cpc   ?? 70 }} />
              <col style={{ width: colWidths.total      ?? 65 }} />
              <col style={{ width: colWidths.totalCases ?? 65 }} />
              {orderedStates.map(st => <col key={st} style={{ width: colWidths[st] ?? 110 }} />)}
            </colgroup>
            <thead>
              <tr>
                {selecting && <th className="tracking-th-state" style={{ width: 32 }} />}
                <th className="tracking-th-ad tracking-th-sortable" onClick={() => handleSort('name')}>
                  Ad Name {sortKey === 'name' && <SortArrow dir={sortDir} />}
                  <div className="col-resize-handle" onMouseDown={e => startColResize('adName', 240, e)} />
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('date')}>
                  Date Created {sortKey === 'date' && <SortArrow dir={sortDir} />}
                  <div className="col-resize-handle" onMouseDown={e => startColResize('date', 90, e)} />
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('spend')} style={{ color: '#94a3b8' }}>
                  Spend {sortKey === 'spend' && <SortArrow dir={sortDir} />}
                  <div className="col-resize-handle" onMouseDown={e => startColResize('spend', 80, e)} />
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('cpl')} style={{ color: '#16a34a' }}>
                  CPL {sortKey === 'cpl' && <SortArrow dir={sortDir} />}
                  <div className="col-resize-handle" onMouseDown={e => startColResize('cpl', 70, e)} />
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('cpc')} style={{ color: '#3b82f6' }}>
                  CPC {sortKey === 'cpc' && <SortArrow dir={sortDir} />}
                  <div className="col-resize-handle" onMouseDown={e => startColResize('cpc', 70, e)} />
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('total')}>
                  Total {sortKey === 'total' && <SortArrow dir={sortDir} />}
                  <div className="col-resize-handle" onMouseDown={e => startColResize('total', 65, e)} />
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('totalCases')} style={{ color: '#3b82f6' }}>
                  Cases {sortKey === 'totalCases' && <SortArrow dir={sortDir} />}
                  <div className="col-resize-handle" onMouseDown={e => startColResize('totalCases', 65, e)} />
                </th>
                {orderedStates.map((state, i) => {
                  const colSpend = adNames.reduce((s, a) => s + (spendGrid[a]?.[state] || 0), 0);
                  const colLeads = adNames.reduce((s, a) => s + (grid[a]?.[state]      || 0), 0);
                  const colCases = adNames.reduce((s, a) => s + (caseGrid[a]?.[state]  || 0), 0);
                  return (
                  <th
                    key={state}
                    className={`tracking-th-state${dragOverCol === i ? ' tracking-th-drag-over' : ''}`}
                    draggable
                    onDragStart={() => onColDragStart(i)}
                    onDragOver={e => onColDragOver(e, i)}
                    onDrop={() => onColDrop(i)}
                    onDragEnd={() => { dragColRef.current = null; setDragOverCol(null); }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                      {editingState === state ? (
                        <form style={{ margin: 0 }} onSubmit={e => { e.preventDefault(); saveAccountName(state, editValue); }}>
                          <input
                            autoFocus
                            className="tracking-name-input"
                            value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onBlur={() => saveAccountName(state, editValue)}
                            onClick={e => e.stopPropagation()}
                          />
                        </form>
                      ) : (
                        <button
                          className="tracking-acct-name"
                          title="Click to rename"
                          onClick={e => { e.stopPropagation(); setEditingState(state); setEditValue(accountNames[state] || accountLabel(state)); }}
                        >
                          {accountLabel(state)}
                        </button>
                      )}
                      <span className="tracking-state-key">{state}</span>
                      <button
                        className={`tracking-sort-btn${sortKey === state ? ' tracking-sort-btn--active' : ''}`}
                        onClick={e => { e.stopPropagation(); handleSort(state); }}
                        title="Sort by this column"
                      >
                        Sort {sortKey === state && <SortArrow dir={sortDir} />}
                      </button>
                      {colSpend > 0 && (
                        <div className="col-stat-block">
                          <span style={{ color: '#64748b' }}>${colSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
                          {colLeads > 0 && <span style={{ color: '#16a34a' }}>CPL ${(colSpend / colLeads).toFixed(0)}</span>}
                          {colCases > 0 && <span style={{ color: '#3b82f6' }}>CPC ${(colSpend / colCases).toFixed(0)}</span>}
                        </div>
                      )}
                    </div>
                    <div className="col-resize-handle" onMouseDown={e => startColResize(state, 110, e)} />
                  </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedAdNames.map(adName => {
                const row        = grid[adName]      || {};
                const caseRow    = caseGrid[adName]  || {};
                const spendRow   = spendGrid[adName] || {};
                const mergeGroup = mergeGroups.find(g => g.canonical === adName);
                const totalLeads = orderedStates.reduce((s, st) => s + (row[st]     || 0), 0);
                const totalCases = orderedStates.reduce((s, st) => s + (caseRow[st] || 0), 0);
                const totalSpend = orderedStates.reduce((s, st) => s + (spendRow[st] || 0), 0);
                const cpl        = totalLeads > 0 ? totalSpend / totalLeads : null;
                const cpc        = totalCases > 0 ? totalSpend / totalCases : null;
                const isSelected = selectedRows.has(adName);
                return (
                  <tr key={adName} className={isSelected ? 'tracking-row-selected' : ''} onClick={selecting ? () => toggleRowSelect(adName) : undefined} style={{ height: rowHeights[adName] ?? undefined, overflow: 'hidden', ...(selecting ? { cursor: 'pointer' } : {}) }}>
                    {selecting && (
                      <td className="tracking-td-cell" style={{ textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleRowSelect(adName)}
                          onClick={e => e.stopPropagation()}
                          style={{ accentColor: 'var(--green)', width: 14, height: 14 }}
                        />
                      </td>
                    )}
                    <td className="tracking-td-ad" title={adName} style={{ position: 'relative' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span className="tracking-ad-name">{adName}</span>
                        {mergeGroup && (
                          <span className="tracking-merge-badge">{mergeGroup.members.length} ads</span>
                        )}
                        {allAdDailyInsights.some(r => {
                          const effectiveNames = mergeGroup ? mergeGroup.members : [adName];
                          return effectiveNames.some(n => allAds.find(a => a.name?.trim() === n && a.id === r.ad_id));
                        }) && (
                          <span className="tracking-synced-badge" title="Ad-level daily data synced">✓</span>
                        )}
                        {!selecting && (
                          <>
                            <button
                              className="ad-row-sync-btn"
                              onClick={e => { e.stopPropagation(); syncAdMax([adName]); }}
                              disabled={syncingAdMax}
                              title="Sync all-time daily data for this ad"
                            >
                              ↻
                            </button>
                            <button
                              className="ad-row-delete-btn"
                              onClick={e => { e.stopPropagation(); deleteAd(adName); }}
                              title="Hide this ad permanently"
                            >
                              ×
                            </button>
                          </>
                        )}
                      </div>
                      <div className="row-resize-handle" onMouseDown={e => startRowResize(adName, e)} />
                    </td>
                    <td className="tracking-td-date">{fmtDateNum(firstUsed[adName])}</td>
                    <td className="tracking-td-total" style={{ color: '#94a3b8', fontSize: 12 }}>
                      {totalSpend > 0 ? `$${totalSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td className="tracking-td-total" style={{ color: '#16a34a', fontSize: 12 }}>
                      {cpl != null ? `$${cpl.toFixed(0)}` : '—'}
                    </td>
                    <td className="tracking-td-total" style={{ color: '#3b82f6', fontSize: 12 }}>
                      {cpc != null ? `$${cpc.toFixed(0)}` : '—'}
                    </td>
                    <td className="tracking-td-total" style={{ fontWeight: 700 }}>
                      {totalLeads > 0 ? totalLeads : '—'}
                    </td>
                    <td className="tracking-td-total" style={{ fontWeight: 700, color: '#3b82f6' }}>
                      {totalCases > 0 ? totalCases : '—'}
                    </td>
                    {orderedStates.map(state => {
                      const leads   = row[state]     || 0;
                      const cases   = caseRow[state] || 0;
                      const hasData = leads > 0 || cases > 0;
                      const status  = cellStatus[adName]?.[state];
                      const cellBg  = status === 'solo' ? 'rgba(34,197,94,0.12)' : status === 'shared' ? 'rgba(59,130,246,0.12)' : undefined;
                      return (
                        <td key={state} className="tracking-td-cell" style={cellBg ? { background: cellBg } : undefined}>
                          {hasData
                            ? (
                              <button
                                className="tracking-cell-btn"
                                onClick={e => { e.stopPropagation(); setAdDetail({ adName, state }); }}
                                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                              >
                                <span className={`cell-leads${leads === 0 ? ' cell-zero' : ''}`}>{leads}</span>
                                <span className="cell-sep">|</span>
                                <span className={`cell-cases${cases === 0 ? ' cell-zero' : ''}`}>{cases}</span>
                              </button>
                            )
                            : <span className="tracking-cell-empty">—</span>
                          }
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                {selecting && <td />}
                <td className="tracking-td-ad tracking-tfoot-label">Total</td>
                <td className="tracking-td-date tracking-tfoot-label" />
                {(() => {
                  const totSpend = adNames.reduce((s, a) => s + orderedStates.reduce((s2, st) => s2 + (spendGrid[a]?.[st] || 0), 0), 0);
                  const totLeads = adNames.reduce((s, a) => s + orderedStates.reduce((s2, st) => s2 + (grid[a]?.[st]      || 0), 0), 0);
                  const totCases = adNames.reduce((s, a) => s + orderedStates.reduce((s2, st) => s2 + (caseGrid[a]?.[st]  || 0), 0), 0);
                  return (<>
                    <td className="tracking-td-total tracking-tfoot-label" style={{ color: '#94a3b8' }}>
                      {totSpend > 0 ? `$${totSpend.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td className="tracking-td-total tracking-tfoot-label" style={{ color: '#16a34a' }}>
                      {totLeads > 0 ? `$${(totSpend / totLeads).toFixed(0)}` : '—'}
                    </td>
                    <td className="tracking-td-total tracking-tfoot-label" style={{ color: '#3b82f6' }}>
                      {totCases > 0 ? `$${(totSpend / totCases).toFixed(0)}` : '—'}
                    </td>
                    <td className="tracking-td-total tracking-tfoot-label" style={{ fontWeight: 700 }}>
                      {totLeads > 0 ? totLeads : '—'}
                    </td>
                    <td className="tracking-td-total tracking-tfoot-label" style={{ fontWeight: 700, color: '#3b82f6' }}>
                      {totCases > 0 ? totCases : '—'}
                    </td>
                  </>);
                })()}
                {orderedStates.map(state => {
                  const leads = adNames.reduce((s, a) => s + (grid[a]?.[state]     || 0), 0);
                  const cases = adNames.reduce((s, a) => s + (caseGrid[a]?.[state] || 0), 0);
                  return (
                    <td key={state} className="tracking-td-total tracking-tfoot-label">
                      {(leads > 0 || cases > 0) ? (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'center' }}>
                          <span className="cell-leads">{leads}</span>
                          <span className="cell-sep">|</span>
                          <span className="cell-cases">{cases}</span>
                        </span>
                      ) : '—'}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Floating action bar (1+ rows selected) */}
      {selecting && selectedRows.size >= 1 && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
          padding: '10px 18px', display: 'flex', gap: 12, alignItems: 'center',
          boxShadow: '0 4px 24px rgba(0,0,0,0.18)', zIndex: 200, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{selectedRows.size} ad{selectedRows.size !== 1 ? 's' : ''} selected</span>
          <button
            className="btn btn--sm btn--primary"
            onClick={() => syncAdMax([...selectedRows])}
            disabled={syncingAdMax}
            title="Fetch all-time daily data for these ads only (efficient — no full account scan)"
          >
            {syncingAdMax ? 'Syncing…' : 'Sync Max'}
          </button>
          {selectedRows.size >= 2 && (
            <button className="btn btn--sm" onClick={openMergeDialog}>
              Combine
            </button>
          )}
          <button className="btn btn--sm" onClick={() => { setSelectedRows(new Set()); setSelecting(false); }}>
            Cancel
          </button>
          {adMaxNote && (
            <span style={{ fontSize: 11, color: adMaxNote.startsWith('Sync failed') ? '#dc2626' : 'var(--green-dark)', maxWidth: 300 }}>
              {adMaxNote}
            </span>
          )}
        </div>
      )}

      {/* Merge dialog */}
      {mergeDialog && (
        <div className="col-mgr-overlay" onClick={e => e.target === e.currentTarget && setMergeDialog(null)}>
          <div className="col-mgr-panel" style={{ width: 440 }}>
            <div className="col-mgr-head">
              <div className="col-mgr-title">Combine {mergeDialog.names.length} Ads</div>
              <button className="col-mgr-x" onClick={() => setMergeDialog(null)}>×</button>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
                Choose which name to display as the canonical (merged) row:
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
                {mergeDialog.names.map(name => (
                  <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', borderRadius: 6, cursor: 'pointer', background: mergeDialog.canonical === name ? 'var(--bg)' : 'transparent' }}>
                    <input
                      type="radio"
                      name="mergeCanonical"
                      value={name}
                      checked={mergeDialog.canonical === name}
                      onChange={() => setMergeDialog(d => ({ ...d, canonical: name }))}
                      style={{ accentColor: 'var(--green)' }}
                    />
                    <span style={{ fontSize: 13 }}>{name}</span>
                  </label>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
                <button className="btn btn--sm" onClick={() => setMergeDialog(null)}>Cancel</button>
                <button className="btn btn--sm btn--primary" onClick={confirmMerge}>
                  Combine
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Ad Detail Modal */}
      {adDetail && (
        <AdDetailModal
          adName={adDetail.adName}
          state={adDetail.state}
          allAds={allAds}
          sheetByName={sheetByName}
          accountLabel={accountLabel}
          mergeGroups={mergeGroups}
          allAdDailyInsights={allAdDailyInsights}
          onSyncMax={syncAdMax}
          onUnmerge={unmergeGroup}
          onClose={() => setAdDetail(null)}
        />
      )}
    </div>
  );
}
