import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { dbGetAll, dbUpsert, dbGetMeta, dbSetMeta, dbClearAll } from './db.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

async function apiFetch(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// Match 2-letter state at end of campaign name after a dash, em-dash, or space
function extractState(campaignName) {
  const m = (campaignName || '').match(/[-–\s]([A-Z]{2})\s*$/i);
  return m ? m[1].toUpperCase() : null;
}

function fmtPhone(p) {
  const d = (p || '').replace(/\D/g, '');
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1,4)}) ${d.slice(4,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Extract MMDD date from the start of an ad name (e.g. "0304-IG SC-2-img" → Mar 4)
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
  { key: 'leads', label: 'Leads/Day',  color: '#3a8f5c', fmt: v => v },
  { key: 'spend', label: 'Spend/Day',  color: '#6366f1', fmt: v => `$${v}` },
  { key: 'cpm',   label: 'CPM/Day',    color: '#f59e0b', fmt: v => v != null ? `$${v}` : '—' },
  { key: 'cpl',   label: 'Cost/Lead',  color: '#ef4444', fmt: v => v != null ? `$${v}` : '—' },
];

const CHART_PERIODS = [
  { key: '30',  label: '30D' },
  { key: '90',  label: '90D' },
  { key: '365', label: '1Y'  },
  { key: 'all', label: 'All' },
];

function CustomTooltip({ active, payload, label, metricKey }) {
  if (!active || !payload?.length) return null;
  const m = CHART_METRICS.find(x => x.key === metricKey);
  const val = payload[0]?.value;
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontWeight: 600 }}>{m ? m.fmt(val) : val}</div>
    </div>
  );
}

function SortArrow({ dir }) {
  return <span style={{ fontSize: 9, marginLeft: 3 }}>{dir === 'asc' ? '▲' : '▼'}</span>;
}

const AD_DETAIL_TABLE_COLS = [
  { key: 'campaign',    label: 'Campaign'   },
  { key: 'adset',       label: 'Adset'      },
  { key: 'status',      label: 'Status'     },
  { key: 'spend',       label: 'Spend'      },
  { key: 'fbLeads',     label: 'FB Leads'   },
  { key: 'cpl',         label: 'Cost/Lead'  },
  { key: 'cpm',         label: 'CPM'        },
  { key: 'ctr',         label: 'CTR'        },
  { key: 'clicks',      label: 'Clicks'     },
  { key: 'created',     label: 'Created'    },
];

function AdDetailModal({ adName, state, allAds, allContacts, sheetByName, accountLabel, onClose }) {
  const [period, setPeriod]     = useState('90');
  const [sortKey, setSortKey]   = useState('spend');
  const [sortDir, setSortDir]   = useState('desc');

  // All FB ad records that share this ad name
  const fbInstances = useMemo(() =>
    allAds.filter(a => (a.name || '').trim() === adName),
    [allAds, adName]
  );

  // Unique adsets this ad has lived in
  const adsets = useMemo(() => {
    const seen = new Set();
    const list = [];
    for (const a of fbInstances) {
      if (!seen.has(a.adsetId)) {
        seen.add(a.adsetId);
        list.push({ id: a.adsetId, name: a.adsetName, campaign: a.campaignName });
      }
    }
    return list;
  }, [fbInstances]);

  // GHL leads for this ad + state
  const ghlLeads = useMemo(() =>
    allContacts.filter(c =>
      (c.utmContent || '').trim() === adName && extractState(c.utmCampaign) === state
    ),
    [allContacts, adName, state]
  );

  const importedCount = sheetByName[adName]?.leads?.[state] || 0;
  const totalLeads    = ghlLeads.length + importedCount;

  // Chart data: GHL leads per day (filtered by period)
  const cutoff = useMemo(() => {
    if (period === 'all') return null;
    return new Date(Date.now() - parseInt(period) * 864e5).toISOString().slice(0, 10);
  }, [period]);

  const chartData = useMemo(() => {
    const map = {};
    for (const c of ghlLeads) {
      if (!c.dateAdded) continue;
      const day = c.dateAdded.slice(0, 10);
      if (cutoff && day < cutoff) continue;
      map[day] = (map[day] || 0) + 1;
    }
    return Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, leads]) => ({ date: date.slice(5), leads }));
  }, [ghlLeads, cutoff]);

  // Table rows: one per FB ad instance
  const tableRows = useMemo(() =>
    fbInstances.map(a => ({
      id:       a.id,
      campaign: a.campaignName || '—',
      adset:    a.adsetName    || '—',
      status:   a.status       || '—',
      spend:    parseFloat(a.spend)  || 0,
      fbLeads:  a.results            || 0,
      cpl:      a.results > 0 && parseFloat(a.spend) > 0
                  ? parseFloat((parseFloat(a.spend) / a.results).toFixed(2))
                  : null,
      cpm:      parseFloat(a.cpm)    || 0,
      ctr:      parseFloat(a.ctr)    || 0,
      clicks:   parseInt(a.clicks)   || 0,
      created:  a.createdTime        || '',
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

  // Totals row
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
    if (key === 'ctr')     return `${val.toFixed(2)}%`;
    if (key === 'created') return fmtDate(val);
    if (key === 'status')  return <span style={{ color: val === 'ACTIVE' ? '#22c55e' : '#94a3b8', fontSize: 11, fontWeight: 600 }}>{val}</span>;
    return val;
  }

  return (
    <div className="ad-detail-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="ad-detail-panel">
        {/* Header */}
        <div className="col-mgr-head">
          <div>
            <div className="col-mgr-title">{adName}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {accountLabel(state)} ({state}) · {totalLeads} total leads
              {importedCount > 0 && <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>({ghlLeads.length} live + {importedCount} imported)</span>}
            </div>
          </div>
          <button className="col-mgr-x" onClick={onClose}>×</button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, padding: '0 20px 20px' }}>
          {/* Adsets section */}
          {adsets.length > 0 && (
            <div style={{ marginTop: 16, marginBottom: 20 }}>
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

          {/* Per-ad leads chart */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
                Leads / Day
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
                  No GHL leads in this period
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={chartData} margin={{ top: 4, right: 20, bottom: 4, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} allowDecimals={false} />
                    <Tooltip content={<CustomTooltip metricKey="leads" />} />
                    <Line type="linear" dataKey="leads" stroke="#3a8f5c" dot={false} strokeWidth={2} connectNulls />
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
                        {AD_DETAIL_TABLE_COLS.map(col => (
                          <td key={col.key} className="tracking-td-cell" style={{ whiteSpace: col.key === 'campaign' || col.key === 'adset' ? 'normal' : 'nowrap', maxWidth: col.key === 'campaign' || col.key === 'adset' ? 200 : undefined }}>
                            {fmtCell(col.key, row[col.key])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
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

          {fbInstances.length === 0 && ghlLeads.length === 0 && (
            <div className="empty" style={{ padding: 48 }}>No data found for this ad</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdsTracking() {
  // Persistent data (from IndexedDB)
  const [allContacts, setAllContacts]           = useState([]);
  const [allDailyInsights, setAllDailyInsights] = useState([]);
  const [allAds, setAllAds]                     = useState([]);
  const [sheetImport, setSheetImport]           = useState([]);
  const [sheetColumns, setSheetColumns]         = useState([]); // [{ key, fullName }]
  const [lastSync, setLastSync]                 = useState(null);
  const [importing, setImporting]               = useState(false);
  const [importNote, setImportNote]             = useState('');

  // Sync state
  const [syncing, setSyncing]     = useState(false);
  const [syncNote, setSyncNote]   = useState('');
  const [syncError, setSyncError] = useState('');

  // UI state
  const [accountNames, setAccountNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trackingAccountNames') || '{}'); }
    catch { return {}; }
  });
  const [editingState, setEditingState] = useState(null);
  const [editValue, setEditValue]       = useState('');
  const [adDetail, setAdDetail]         = useState(null); // { adName, state }
  const [chartMetric, setChartMetric]   = useState('leads');
  const [chartPeriod, setChartPeriod]   = useState('90');
  const [sortKey, setSortKey]           = useState('date');
  const [sortDir, setSortDir]           = useState('asc');
  const [colOrder, setColOrder]         = useState(null);
  const dragColRef  = useRef(null);
  const [dragOverCol, setDragOverCol]   = useState(null);
  const syncingRef = useRef(false);

  // ── Load from IndexedDB ────────────────────────────────────────────────────
  async function loadFromDB() {
    const [contacts, insights, ads, imported, cols, syncTime] = await Promise.all([
      dbGetAll('ghlContacts'),
      dbGetAll('fbDailyInsights'),
      dbGetAll('fbAds'),
      dbGetAll('sheetImport'),
      dbGetMeta('trackingColumns'),
      dbGetMeta('lastSync'),
    ]);
    setAllContacts(contacts);
    setAllDailyInsights(insights);
    setAllAds(ads);
    setSheetImport(imported);
    setSheetColumns(cols || []);
    setLastSync(syncTime);
  }

  // ── Import from Google Sheet ───────────────────────────────────────────────
  async function importFromSheet() {
    setImporting(true);
    setImportNote('');
    try {
      const { columns, rows } = await apiFetch('/api/sheets/tracking-import');
      await Promise.all([
        dbUpsert('sheetImport', rows),
        dbSetMeta('trackingColumns', columns),
      ]);
      const [all, cols] = await Promise.all([
        dbGetAll('sheetImport'),
        dbGetMeta('trackingColumns'),
      ]);
      setSheetImport(all);
      setSheetColumns(cols || []);
      const totalLeads = rows.reduce((s, r) => s + Object.values(r.leads).reduce((a, b) => a + b, 0), 0);
      setImportNote(`Imported ${rows.length} ads · ${columns.length} accounts · ${totalLeads} historical leads`);
    } catch (err) {
      setImportNote(`Import failed: ${err.message.slice(0, 80)}`);
    } finally {
      setImporting(false);
    }
  }

  // ── Incremental sync ──────────────────────────────────────────────────────
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

      // 1. GHL contacts: everything since last sync (2 years back on first run)
      const since = lastSyncTime
        ? lastSyncTime
        : new Date(Date.now() - 2 * 365 * 864e5).toISOString();
      setSyncNote('Fetching leads…');
      const contacts = await apiFetch(
        `/api/ghl/contacts?start=${encodeURIComponent(since)}&end=${encodeURIComponent(now)}`
      );
      await dbUpsert('ghlContacts', contacts);

      // 2. FB ads: maximum preset to capture all-time ad list
      setSyncNote('Fetching ads…');
      const ads = await apiFetch('/api/facebook/ads?date_preset=maximum');
      await dbUpsert('fbAds', ads);

      // 3. FB daily insights:
      //    First sync → last 365 days of history
      //    Incremental → last 14 days (covers FB's 3-day reporting delay)
      setSyncNote('Fetching daily insights…');
      const preset = isFirstSync ? 'maximum' : 'last_14d';
      const dailyRaw = await apiFetch(`/api/facebook/daily?date_preset=${preset}`);
      // Synthetic key: date + campaign id to allow upsert/overwrite
      const dailyRecords = dailyRaw.map(r => ({
        ...r,
        id: `${r.date_start}|${r.campaign_id || r.adset_id || r.ad_id || 'agg'}`,
      }));
      await dbUpsert('fbDailyInsights', dailyRecords);

      await dbSetMeta('lastSync', now);
      await loadFromDB();
      setSyncNote(`Done · +${contacts.length} new leads`);
    } catch (err) {
      console.error('Sync error:', err);
      setSyncError(err.message);
      setSyncNote('');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // Lightweight lead sync: only GHL contacts since lastSync — always runs on mount
  const syncLeads = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError('');
    setSyncNote('Fetching new leads…');
    try {
      const lastSyncTime = await dbGetMeta('lastSync');
      const since = lastSyncTime
        ? lastSyncTime
        : new Date(Date.now() - 2 * 365 * 864e5).toISOString();
      const now = new Date().toISOString();
      const contacts = await apiFetch(
        `/api/ghl/contacts?start=${encodeURIComponent(since)}&end=${encodeURIComponent(now)}`
      );
      await dbUpsert('ghlContacts', contacts);
      await dbSetMeta('lastSync', now);
      const all = await dbGetAll('ghlContacts');
      setAllContacts(all);
      setLastSync(now);
      setSyncNote(`+${contacts.length} new leads`);
    } catch (err) {
      console.error('Lead sync error:', err);
      setSyncError(err.message);
      setSyncNote('');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // On mount: load cache immediately, always sync leads, full sync only if stale (> 6h)
  useEffect(() => {
    loadFromDB().then(async () => {
      const ts    = await dbGetMeta('lastSync');
      const stale = !ts || (Date.now() - new Date(ts).getTime() > 6 * 3600 * 1000);
      if (stale) sync(); // full sync (GHL + FB)
      else syncLeads();   // leads-only sync
    });
  }, []);

  async function resetData() {
    if (!window.confirm('Clear all stored tracking data and re-sync from scratch?')) return;
    await dbClearAll();
    setAllContacts([]);
    setAllDailyInsights([]);
    setAllAds([]);
    setLastSync(null);
    setSyncNote('');
    setSyncError('');
    sync();
  }

  // ── Derived data ──────────────────────────────────────────────────────────

  // Column keys in sheet order; fall back to GHL-derived states if no import yet
  const states = useMemo(() => {
    if (sheetColumns.length > 0) return sheetColumns.map(c => c.key);
    const set = new Set();
    for (const c of allContacts) {
      const s = extractState(c.utmCampaign);
      if (s) set.add(s);
    }
    return [...set].sort();
  }, [sheetColumns, allContacts]);

  const orderedStates = useMemo(() => {
    if (!colOrder) return states;
    const existing = colOrder.filter(s => states.includes(s));
    const newOnes  = states.filter(s => !colOrder.includes(s));
    return [...existing, ...newOnes];
  }, [states, colOrder]);

  // Lookup map for sheet import: adName → { date, leads: { SC: N, ... } }
  const sheetByName = useMemo(() => {
    const map = {};
    for (const row of sheetImport) map[row.adName] = row;
    return map;
  }, [sheetImport]);

  // Ad names: union of FB ads AND sheet import (sheet gives us historical ads)
  const adNames = useMemo(() => {
    const seen  = new Set();
    const names = [];
    // FB ads first
    for (const a of allAds) {
      if (a.name && !seen.has(a.name.trim())) {
        seen.add(a.name.trim());
        names.push(a.name.trim());
      }
    }
    // Sheet import ads (may include ads no longer in FB)
    for (const row of sheetImport) {
      if (row.adName && !seen.has(row.adName)) {
        seen.add(row.adName);
        names.push(row.adName);
      }
    }
    return names;
  }, [allAds, sheetImport]);

  const grid = useMemo(() => {
    const map = {};
    for (const adName of adNames) {
      map[adName] = {};
      for (const state of states) map[adName][state] = [];
    }
    for (const c of allContacts) {
      const state  = extractState(c.utmCampaign);
      const adName = (c.utmContent || '').trim();
      if (state && adName && map[adName]?.[state] !== undefined) {
        map[adName][state].push(c);
      }
    }
    return map;
  }, [adNames, states, allContacts]);

  // Date derived directly from MMDD prefix in the ad name — single source of truth
  const firstUsed = useMemo(() => {
    const map = {};
    for (const adName of adNames) {
      const iso = parseAdNameDate(adName);
      if (iso) map[adName] = iso;
    }
    return map;
  }, [adNames]);

  const sortedAdNames = useMemo(() => {
    return [...adNames].sort((a, b) => {
      let av, bv;
      if (sortKey === 'name') {
        av = a.toLowerCase(); bv = b.toLowerCase();
      } else if (sortKey === 'date') {
        av = firstUsed[a] || '9999'; bv = firstUsed[b] || '9999';
      } else if (sortKey === 'total') {
        av = states.reduce((s, st) => s + (grid[a]?.[st]?.length || 0) + (sheetByName[a]?.leads?.[st] || 0), 0);
        bv = states.reduce((s, st) => s + (grid[b]?.[st]?.length || 0) + (sheetByName[b]?.leads?.[st] || 0), 0);
      } else {
        av = (grid[a]?.[sortKey]?.length || 0) + (sheetByName[a]?.leads?.[sortKey] || 0);
        bv = (grid[b]?.[sortKey]?.length || 0) + (sheetByName[b]?.leads?.[sortKey] || 0);
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1  : -1;
      return 0;
    });
  }, [adNames, sortKey, sortDir, grid, firstUsed, states]);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'date' || key === 'name' ? 'asc' : 'desc'); }
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
    const leadsMap = {};
    for (const c of allContacts) {
      if (!c.dateAdded) continue;
      const day = c.dateAdded.slice(0, 10);
      if (cutoffDate && day < cutoffDate) continue;
      leadsMap[day] = (leadsMap[day] || 0) + 1;
    }
    const fbMap = {};
    for (const row of allDailyInsights) {
      const date = row.date_start;
      if (!date) continue;
      if (cutoffDate && date < cutoffDate) continue;
      if (!fbMap[date]) fbMap[date] = { spend: 0, cpm_sum: 0, cpm_count: 0 };
      fbMap[date].spend += parseFloat(row.spend) || 0;
      if (row.cpm) { fbMap[date].cpm_sum += parseFloat(row.cpm); fbMap[date].cpm_count++; }
    }
    const allDates = new Set([...Object.keys(leadsMap), ...Object.keys(fbMap)]);
    return [...allDates].sort().map(date => {
      const fb    = fbMap[date] || {};
      const leads = leadsMap[date] || 0;
      const spend = +(fb.spend || 0).toFixed(2);
      const cpm   = fb.cpm_count > 0 ? +(fb.cpm_sum / fb.cpm_count).toFixed(2) : null;
      const cpl   = leads > 0 && spend > 0 ? +(spend / leads).toFixed(2) : null;
      return { date: date.slice(5), leads, spend, cpm, cpl };
    });
  }, [allContacts, allDailyInsights, cutoffDate]);

  function saveAccountName(state, name) {
    const next = { ...accountNames, [state]: name.trim() || state };
    setAccountNames(next);
    localStorage.setItem('trackingAccountNames', JSON.stringify(next));
    setEditingState(null);
  }

  function accountLabel(state) {
    if (accountNames[state]) return accountNames[state];
    const col = sheetColumns.find(c => c.key === state);
    return col?.fullName || state;
  }

  const activeMetric = CHART_METRICS.find(m => m.key === chartMetric);

  // ── Render ────────────────────────────────────────────────────────────────
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
            <button className="btn btn--sm" onClick={importFromSheet} disabled={importing || syncing} title="Import lead counts from your Google Sheet">
              {importing ? 'Importing…' : '📋 Import Sheet'}
            </button>
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
          {importNote && (
            <span style={{ fontSize: 11, color: importNote.startsWith('Import failed') ? '#dc2626' : 'var(--green-dark)' }}>
              {importNote}
            </span>
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
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            {CHART_PERIODS.map(p => (
              <button key={p.key} className={`btn btn--sm${chartPeriod === p.key ? ' btn--primary' : ''}`} onClick={() => setChartPeriod(p.key)}>
                {p.label}
              </button>
            ))}
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
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {allContacts.length.toLocaleString()} live leads
          {sheetImport.length > 0 && ` · ${sheetImport.reduce((s, r) => s + Object.values(r.leads).reduce((a, b) => a + b, 0), 0).toLocaleString()} imported`}
          {' · '}{adNames.length} unique ads
        </span>
      </div>

      {adNames.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📊</div>
          <div className="empty-title">{syncing ? 'Syncing data…' : 'No data yet'}</div>
          <div className="empty-desc">
            {syncing ? 'This may take a moment on first sync.' : 'Click "Sync Now" to load your ads and leads.'}
          </div>
        </div>
      ) : (
        <div className="tracking-grid-wrap">
          <table className="tracking-grid">
            <thead>
              <tr>
                <th className="tracking-th-ad tracking-th-sortable" onClick={() => handleSort('name')}>
                  Ad Name {sortKey === 'name' && <SortArrow dir={sortDir} />}
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('date')}>
                  First Used {sortKey === 'date' && <SortArrow dir={sortDir} />}
                </th>
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('total')}>
                  Total {sortKey === 'total' && <SortArrow dir={sortDir} />}
                </th>
                {orderedStates.map((state, i) => (
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
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedAdNames.map(adName => {
                const row   = grid[adName] || {};
                const total = orderedStates.reduce((s, st) =>
                  s + (row[st]?.length || 0) + (sheetByName[adName]?.leads?.[st] || 0), 0);
                return (
                  <tr key={adName}>
                    <td className="tracking-td-ad" title={adName}>
                      <span className="tracking-ad-name">{adName}</span>
                    </td>
                    <td className="tracking-td-date">{fmtDate(firstUsed[adName])}</td>
                    <td className="tracking-td-total">{total > 0 ? total : '—'}</td>
                    {orderedStates.map(state => {
                      const leads      = row[state] || [];
                      const imported   = sheetByName[adName]?.leads?.[state] || 0;
                      const cellTotal  = leads.length + imported;
                      return (
                        <td key={state} className="tracking-td-cell">
                          {cellTotal > 0
                            ? <button className="tracking-cell-btn" onClick={() => setAdDetail({ adName, state })}>{cellTotal}</button>
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
                <td className="tracking-td-ad tracking-tfoot-label">Total</td>
                <td className="tracking-td-date tracking-tfoot-label" />
                <td className="tracking-td-total tracking-tfoot-label">
                  {adNames.reduce((s, a) => s + orderedStates.reduce((s2, st) =>
                    s2 + (grid[a]?.[st]?.length || 0) + (sheetByName[a]?.leads?.[st] || 0), 0), 0) || '—'}
                </td>
                {orderedStates.map(state => {
                  const total = adNames.reduce((s, a) =>
                    s + (grid[a]?.[state]?.length || 0) + (sheetByName[a]?.leads?.[state] || 0), 0);
                  return <td key={state} className="tracking-td-total tracking-tfoot-label">{total > 0 ? total : '—'}</td>;
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Ad Detail Modal */}
      {adDetail && (
        <AdDetailModal
          adName={adDetail.adName}
          state={adDetail.state}
          allAds={allAds}
          allContacts={allContacts}
          sheetByName={sheetByName}
          accountLabel={accountLabel}
          onClose={() => setAdDetail(null)}
        />
      )}
    </div>
  );
}
