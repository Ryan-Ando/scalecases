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

function extractState(campaignName) {
  const m = (campaignName || '').match(/[-–]\s*([A-Z]{2})\s*$/i);
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

export default function AdsTracking() {
  // Persistent data (from IndexedDB)
  const [allContacts, setAllContacts]           = useState([]);
  const [allDailyInsights, setAllDailyInsights] = useState([]);
  const [allAds, setAllAds]                     = useState([]);
  const [sheetImport, setSheetImport]           = useState([]); // manual sheet import
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
  const [cellDetail, setCellDetail]     = useState(null);
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
    const [contacts, insights, ads, imported, syncTime] = await Promise.all([
      dbGetAll('ghlContacts'),
      dbGetAll('fbDailyInsights'),
      dbGetAll('fbAds'),
      dbGetAll('sheetImport'),
      dbGetMeta('lastSync'),
    ]);
    setAllContacts(contacts);
    setAllDailyInsights(insights);
    setAllAds(ads);
    setSheetImport(imported);
    setLastSync(syncTime);
  }

  // ── Import from Google Sheet ───────────────────────────────────────────────
  async function importFromSheet() {
    setImporting(true);
    setImportNote('');
    try {
      const data = await apiFetch('/api/sheets/tracking-import');
      await dbUpsert('sheetImport', data);
      const all = await dbGetAll('sheetImport');
      setSheetImport(all);
      const totalLeads = data.reduce((s, r) => s + Object.values(r.leads).reduce((a, b) => a + b, 0), 0);
      setImportNote(`Imported ${data.length} ads · ${totalLeads} historical leads`);
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

  // On mount: load cached data immediately, then auto-sync if stale (> 6 hours)
  useEffect(() => {
    loadFromDB().then(async () => {
      const ts    = await dbGetMeta('lastSync');
      const stale = !ts || (Date.now() - new Date(ts).getTime() > 6 * 3600 * 1000);
      if (stale) sync();
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

  const states = useMemo(() => {
    const set = new Set();
    for (const c of allContacts) {
      const s = extractState(c.utmCampaign);
      if (s) set.add(s);
    }
    return [...set].sort();
  }, [allContacts]);

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

  function accountLabel(state) { return accountNames[state] || state; }

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
                <Line type="monotone" dataKey={chartMetric} stroke={activeMetric?.color || '#3a8f5c'} dot={false} strokeWidth={2} connectNulls />
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
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
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
                          onClick={e => { e.stopPropagation(); setEditingState(state); setEditValue(accountNames[state] || state); }}
                        >
                          {accountLabel(state)}
                        </button>
                      )}
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
                <th className="tracking-th-state tracking-th-sortable" onClick={() => handleSort('total')}>
                  Total {sortKey === 'total' && <SortArrow dir={sortDir} />}
                </th>
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
                    {orderedStates.map(state => {
                      const leads      = row[state] || [];
                      const imported   = sheetByName[adName]?.leads?.[state] || 0;
                      const total      = leads.length + imported;
                      return (
                        <td key={state} className="tracking-td-cell">
                          {total > 0
                            ? <button className="tracking-cell-btn" onClick={() => setCellDetail({ adName, state, leads, imported })}>{total}</button>
                            : <span className="tracking-cell-empty">—</span>
                          }
                        </td>
                      );
                    })}
                    <td className="tracking-td-total">{total > 0 ? total : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="tracking-td-ad tracking-tfoot-label">Total</td>
                <td className="tracking-td-date tracking-tfoot-label" />
                {orderedStates.map(state => {
                  const total = adNames.reduce((s, a) =>
                    s + (grid[a]?.[state]?.length || 0) + (sheetByName[a]?.leads?.[state] || 0), 0);
                  return <td key={state} className="tracking-td-total tracking-tfoot-label">{total > 0 ? total : '—'}</td>;
                })}
                <td className="tracking-td-total tracking-tfoot-label">
                  {adNames.reduce((s, a) => s + orderedStates.reduce((s2, st) =>
                    s2 + (grid[a]?.[st]?.length || 0) + (sheetByName[a]?.leads?.[st] || 0), 0), 0) || '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {/* Cell Detail Modal */}
      {cellDetail && (
        <div className="col-mgr-overlay" onClick={e => e.target === e.currentTarget && setCellDetail(null)}>
          <div className="col-mgr-panel">
            <div className="col-mgr-head">
              <div>
                <div className="col-mgr-title">{cellDetail.adName}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {accountLabel(cellDetail.state)} · {cellDetail.leads.length + (cellDetail.imported || 0)} total leads
                </div>
              </div>
              <button className="col-mgr-x" onClick={() => setCellDetail(null)}>×</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {/* Sheet-imported historical count */}
              {cellDetail.imported > 0 && (
                <div style={{ padding: '10px 18px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }}>
                    📋 {cellDetail.imported} imported from sheet
                  </span>
                </div>
              )}
              {/* GHL contacts */}
              {cellDetail.leads.length > 0 && (
                <div style={{ padding: '8px 18px 4px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  Live leads
                </div>
              )}
              {[...cellDetail.leads]
                .sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''))
                .map(c => (
                  <div key={c.id} className="case-item">
                    <div className="case-item-name">{c.name}</div>
                    <div className="case-item-meta">
                      <span>{fmtPhone(c.phone)}</span>
                      {c.dateAdded && <span>{fmtDate(c.dateAdded)}</span>}
                    </div>
                  </div>
                ))}
              {cellDetail.leads.length === 0 && cellDetail.imported === 0 && (
                <div className="empty" style={{ padding: 32 }}>No leads</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
