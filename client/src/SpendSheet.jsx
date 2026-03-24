import { useState, useEffect, useMemo, useRef } from 'react';
import { dbGetAll, dbUpsert } from './db.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

function extractState(campaignName) {
  if (!campaignName) return null;
  const tokens = campaignName.trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase();
    if (US_STATES.has(t)) return t;
  }
  return null;
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmt(v) {
  if (!v && v !== 0) return '';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtOrDash(v) {
  if (v == null || v === '') return '—';
  return fmt(v);
}

// ── Pacing helpers ────────────────────────────────────────────────────────────
const PACING_KEY = 'spend_pacing_v1';
function loadPacing() {
  try { return JSON.parse(localStorage.getItem(PACING_KEY) || '{}'); } catch { return {}; }
}
function daysLeft(endDate) {
  if (!endDate) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const end = new Date(endDate + 'T00:00:00');
  const d = Math.floor((end - today) / 86400000);
  return d >= 0 ? d : 0;
}

export default function SpendSheet() {
  const [insights, setInsights]     = useState([]);
  const [adsets, setAdsets]         = useState([]);
  const [loadingBudget, setLoadingBudget] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [syncing, setSyncing]       = useState(false);
  const [syncError, setSyncError]   = useState('');
  const [viewYear, setViewYear]     = useState(new Date().getFullYear());
  const [viewMonth, setViewMonth]   = useState(new Date().getMonth());

  // Pacing state
  const [pacing, setPacing]             = useState(() => loadPacing());
  const [pacingSpend, setPacingSpend]   = useState({});
  const [pacingLoading, setPacingLoading] = useState(false);
  const [pacingError, setPacingError]   = useState('');

  // Column order: persisted to localStorage
  const [colOrder, setColOrder] = useState(() => {
    try { const s = localStorage.getItem('spendSheetColOrder'); return s ? JSON.parse(s) : null; }
    catch { return null; }
  });
  const dragSrc = useRef(null);

  function loadFromDB() {
    return dbGetAll('fbDailyInsights').then(setInsights);
  }

  async function fetchAdsets() {
    setLoadingBudget(true);
    try {
      const res  = await fetch(`${BASE}/api/facebook/adsets`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      setAdsets(data);
    } catch (e) {
      console.warn('Adset budget fetch failed:', e.message);
    } finally {
      setLoadingBudget(false);
    }
  }

  useEffect(() => {
    loadFromDB().finally(() => setLoading(false));
    fetchAdsets();
  }, []);

  // ── Pacing functions ────────────────────────────────────────────────────────
  function updatePacing(st, field, value) {
    setPacing(prev => {
      const next = { ...prev, [st]: { ...prev[st], [field]: value } };
      localStorage.setItem(PACING_KEY, JSON.stringify(next));
      return next;
    });
  }

  function copyDatesToAll(st) {
    const { startDate, endDate } = pacing[st] || {};
    setPacing(prev => {
      const next = { ...prev };
      for (const s of pacingStates) {
        next[s] = { ...next[s], startDate: startDate || '', endDate: endDate || '' };
      }
      localStorage.setItem(PACING_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function fetchPacingSpend() {
    const entries = Object.entries(pacing).filter(([, cfg]) => cfg?.startDate && cfg?.endDate);
    if (!entries.length) { setPacingError('Enter start/end dates for at least one state first.'); return; }

    setPacingLoading(true);
    setPacingError('');
    try {
      // Group states by unique date range to minimise API calls
      const byRange = {};
      for (const [, cfg] of entries) {
        const key = `${cfg.startDate}|${cfg.endDate}`;
        if (!byRange[key]) byRange[key] = { since: cfg.startDate, until: cfg.endDate };
      }

      const spendMap = {};
      await Promise.all(Object.values(byRange).map(async ({ since, until }) => {
        const r = await fetch(`${BASE}/api/facebook/campaign-spend?since=${since}&until=${until}`);
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Fetch failed');
        for (const c of data) {
          const st = extractState(c.campaign_name);
          if (!st) continue;
          spendMap[st] = (spendMap[st] || 0) + c.spend;
        }
      }));
      setPacingSpend(spendMap);
    } catch (e) {
      setPacingError(e.message);
    } finally {
      setPacingLoading(false);
    }
  }

  // ── Live daily budget ───────────────────────────────────────────────────────
  const budgetByState = useMemo(() => {
    const map = {};
    for (const a of adsets) {
      if (a.effectiveStatus !== 'ACTIVE') continue;
      const state = extractState(a.campaignName);
      if (!state) continue;
      const budget = parseFloat(a.dailyBudget) / 100 || 0;
      if (budget <= 0) continue;
      map[state] = (map[state] || 0) + budget;
    }
    return map;
  }, [adsets]);

  const budgetStates     = useMemo(() => Object.keys(budgetByState).sort(), [budgetByState]);
  const totalDailyBudget = useMemo(() => Object.values(budgetByState).reduce((s, v) => s + v, 0), [budgetByState]);

  // ── Pacing table rows ───────────────────────────────────────────────────────
  const pacingStates = useMemo(() => {
    const all = new Set([...budgetStates, ...Object.keys(pacing)]);
    return [...all].sort();
  }, [budgetStates, pacing]);

  const pacingRows = useMemo(() => {
    return pacingStates.map(st => {
      const cfg          = pacing[st] || {};
      const totalBudget  = parseFloat(cfg.totalBudget) || null;
      const startDate    = cfg.startDate || '';
      const endDate      = cfg.endDate   || '';
      const dl           = endDate ? daysLeft(endDate) : null;
      const spentToDate  = pacingSpend[st] ?? null;
      const remaining    = (totalBudget != null && spentToDate != null) ? Math.max(0, totalBudget - spentToDate) : null;
      const dailyNeeded  = (remaining != null && dl != null && dl > 0) ? remaining / dl : (dl === 0 && remaining != null ? remaining : null);
      const liveBudget   = budgetByState[st] || null;
      const shortfall    = (dailyNeeded != null && liveBudget != null) ? dailyNeeded - liveBudget : null;
      return { st, totalBudget, startDate, endDate, daysLeft: dl, spentToDate, remaining, dailyNeeded, liveBudget, shortfall };
    });
  }, [pacingStates, pacing, pacingSpend, budgetByState]);

  // ── Monthly grid ────────────────────────────────────────────────────────────
  async function syncMonth() {
    setSyncing(true);
    setSyncError('');
    try {
      const y = viewYear, m = viewMonth + 1;
      const since = `${y}-${String(m).padStart(2,'0')}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const until   = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const res  = await fetch(`${BASE}/api/facebook/daily?start=${since}&end=${until}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      const records = data.map(r => ({
        ...r,
        id: `${r.date_start}|${r.campaign_id || r.adset_id || r.ad_id || 'agg'}`,
      }));
      await dbUpsert('fbDailyInsights', records);
      await loadFromDB();
    } catch (err) {
      setSyncError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  const { dataStates, days, grid, rowTotals, colTotals, grandTotal } = useMemo(() => {
    const monthStr    = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}`;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const grid        = {};
    const stateSet    = new Set();

    for (const row of insights) {
      if (!row.date_start?.startsWith(monthStr)) continue;
      const state = extractState(row.campaign_name);
      if (!state) continue;
      const day   = parseInt(row.date_start.slice(8), 10);
      const spend = parseFloat(row.spend) || 0;
      if (!grid[day]) grid[day] = {};
      grid[day][state] = (grid[day][state] || 0) + spend;
      stateSet.add(state);
    }

    const dataStates = [...stateSet].sort();
    const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    const rowTotals = {};
    for (const day of days)
      rowTotals[day] = dataStates.reduce((s, st) => s + (grid[day]?.[st] || 0), 0);

    const colTotals = {};
    for (const st of dataStates)
      colTotals[st] = days.reduce((s, day) => s + (grid[day]?.[st] || 0), 0);

    const grandTotal = dataStates.reduce((s, st) => s + colTotals[st], 0);

    return { dataStates, days, grid, rowTotals, colTotals, grandTotal };
  }, [insights, viewYear, viewMonth]);

  const states = useMemo(() => {
    if (!colOrder) return dataStates;
    const ordered = colOrder.filter(s => dataStates.includes(s));
    const added   = dataStates.filter(s => !colOrder.includes(s));
    return [...ordered, ...added];
  }, [dataStates, colOrder]);

  function onDragStart(st) { dragSrc.current = st; }
  function onDragOver(e) { e.preventDefault(); }
  function onDrop(targetSt) {
    if (!dragSrc.current || dragSrc.current === targetSt) return;
    const next = [...states];
    const from = next.indexOf(dragSrc.current);
    const to   = next.indexOf(targetSt);
    next.splice(from, 1);
    next.splice(to, 0, dragSrc.current);
    setColOrder(next);
    localStorage.setItem('spendSheetColOrder', JSON.stringify(next));
    dragSrc.current = null;
  }
  function resetOrder() {
    setColOrder(null);
    localStorage.removeItem('spendSheetColOrder');
  }
  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  // ── Styles ──────────────────────────────────────────────────────────────────
  const thBase = {
    position: 'sticky', top: 0, zIndex: 2,
    background: 'var(--surface)', borderBottom: '2px solid var(--border)',
    padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', textAlign: 'right',
    whiteSpace: 'nowrap', cursor: 'grab', userSelect: 'none',
  };
  const dayTh  = { ...thBase, textAlign: 'left', position: 'sticky', left: 0, zIndex: 3, cursor: 'default', minWidth: 64 };
  const totTh  = { ...thBase, color: 'var(--text)', borderLeft: '2px solid var(--border)', cursor: 'default' };
  const td     = { padding: '6px 10px', fontSize: 12, textAlign: 'right', borderBottom: '1px solid var(--border)' };
  const dayTd  = { ...td, textAlign: 'left', position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', fontWeight: 600, color: 'var(--text-muted)' };
  const totTd  = { ...td, fontWeight: 700, background: 'var(--bg)', borderTop: '2px solid var(--border)' };
  const totDay = { ...dayTd, fontWeight: 700, background: 'var(--bg)', borderTop: '2px solid var(--border)' };

  const pacingInput = {
    background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 4,
    color: 'var(--text)', padding: '4px 7px', fontSize: 12, outline: 'none',
    width: '100%', boxSizing: 'border-box',
  };
  const pTh = {
    padding: '8px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', textAlign: 'right',
    whiteSpace: 'nowrap', background: 'var(--surface)', borderBottom: '2px solid var(--border)',
  };
  const pThL = { ...pTh, textAlign: 'left', position: 'sticky', left: 0, zIndex: 3, minWidth: 60 };
  const pTd = { padding: '8px 12px', fontSize: 12, textAlign: 'right', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const pTdL = { ...pTd, textAlign: 'left', position: 'sticky', left: 0, background: 'var(--surface)', fontWeight: 700, zIndex: 1 };
  const pTdEdit = { ...pTd, padding: '4px 8px', minWidth: 110 };

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Spend Sheet</div>

        {colOrder && (
          <button className="btn btn--sm" onClick={resetOrder} style={{ color: 'var(--text-muted)' }}>
            Reset column order
          </button>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {syncError && <span style={{ fontSize: 11, color: '#dc2626' }} title={syncError}>Sync error</span>}
          <button className="btn btn--sm" onClick={syncMonth} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Month'}
          </button>
          <button className="btn btn--sm" onClick={() => loadFromDB()} disabled={loading}>
            Refresh
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8 }}>
            <button className="btn btn--sm" onClick={prevMonth}>‹</button>
            <span style={{ fontSize: 14, fontWeight: 600, minWidth: 130, textAlign: 'center' }}>
              {MONTH_NAMES[viewMonth]} {viewYear}
            </span>
            <button className="btn btn--sm" onClick={nextMonth}>›</button>
          </div>
        </div>
      </div>

      {/* ── Live Daily Budget ─────────────────────────────────────────────── */}
      {loadingBudget && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>Loading live budgets…</div>
      )}
      {!loadingBudget && budgetStates.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: 'var(--text)' }}>
            Live Daily Budget
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              sum of active adset daily budgets
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            {budgetStates.map(st => (
              <div key={st} style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 16px', minWidth: 90 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{st}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{fmt(budgetByState[st])}</div>
              </div>
            ))}
            <div style={{ background: 'var(--green-light)', border: '1px solid var(--green)', borderRadius: 8, padding: '10px 16px', minWidth: 90 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Total / day</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--green-dark)' }}>{fmt(totalDailyBudget)}</div>
            </div>
          </div>
        </div>
      )}

      {/* ── Budget Pacing ─────────────────────────────────────────────────── */}
      {pacingStates.length > 0 && (
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>
              Budget Pacing
              <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
                daily spend needed to hit budget within timeframe
              </span>
            </div>
            <button className="btn btn--sm" onClick={fetchPacingSpend} disabled={pacingLoading} style={{ marginLeft: 'auto' }}>
              {pacingLoading ? 'Fetching…' : 'Fetch Spend'}
            </button>
          </div>
          {pacingError && <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 8 }}>{pacingError}</div>}

          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 10 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={pThL}>State</th>
                  <th style={{ ...pTh, textAlign: 'left', minWidth: 120 }}>Total Budget</th>
                  <th style={{ ...pTh, textAlign: 'left', minWidth: 150 }}>Start Date</th>
                  <th style={{ ...pTh, textAlign: 'left', minWidth: 150 }}>End Date</th>
                  <th style={pTh}>Days Left</th>
                  <th style={pTh}>Spent to Date</th>
                  <th style={pTh}>Remaining</th>
                  <th style={pTh}>Daily Needed</th>
                  <th style={pTh}>Live Daily Budget</th>
                  <th style={{ ...pTh, borderLeft: '2px solid var(--border)' }}>Shortfall</th>
                </tr>
              </thead>
              <tbody>
                {pacingRows.map(r => {
                  const shortfallColor = r.shortfall == null ? 'var(--text-muted)'
                    : r.shortfall > 0 ? '#dc2626' : '#16a34a';
                  return (
                    <tr key={r.st}>
                      <td style={pTdL}>{r.st}</td>

                      {/* Total Budget — editable */}
                      <td style={pTdEdit}>
                        <input
                          style={pacingInput}
                          type="number"
                          min="0"
                          placeholder="e.g. 50000"
                          value={pacing[r.st]?.totalBudget || ''}
                          onChange={e => updatePacing(r.st, 'totalBudget', e.target.value)}
                        />
                      </td>

                      {/* Start Date — editable */}
                      <td style={pTdEdit}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                          <input
                            style={{ ...pacingInput, flex: 1 }}
                            type="date"
                            value={pacing[r.st]?.startDate || ''}
                            onChange={e => updatePacing(r.st, 'startDate', e.target.value)}
                          />
                          <button
                            title="Copy these dates to all rows"
                            onClick={() => copyDatesToAll(r.st)}
                            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11, padding: '3px 5px', whiteSpace: 'nowrap', flexShrink: 0 }}
                          >⬇ all</button>
                        </div>
                      </td>

                      {/* End Date — editable */}
                      <td style={pTdEdit}>
                        <input
                          style={pacingInput}
                          type="date"
                          value={pacing[r.st]?.endDate || ''}
                          onChange={e => updatePacing(r.st, 'endDate', e.target.value)}
                        />
                      </td>

                      {/* Days Left */}
                      <td style={pTd}>
                        {r.daysLeft == null ? '—' : r.daysLeft === 0
                          ? <span style={{ color: '#dc2626', fontWeight: 700 }}>0</span>
                          : r.daysLeft}
                      </td>

                      {/* Spent to Date */}
                      <td style={pTd}>
                        {pacingLoading ? <span style={{ color: 'var(--text-muted)' }}>…</span> : fmtOrDash(r.spentToDate)}
                      </td>

                      {/* Remaining = Total Budget − Spent */}
                      <td style={pTd}>{fmtOrDash(r.remaining)}</td>

                      {/* Daily Needed = Remaining ÷ Days Left */}
                      <td style={{ ...pTd, fontWeight: 600 }}>{fmtOrDash(r.dailyNeeded)}</td>

                      {/* Live Daily Budget */}
                      <td style={pTd}>{fmtOrDash(r.liveBudget)}</td>

                      {/* Shortfall = Daily Needed − Live Daily Budget */}
                      <td style={{ ...pTd, fontWeight: 700, color: shortfallColor, borderLeft: '2px solid var(--border)' }}>
                        {r.shortfall == null ? '—' : `${r.shortfall >= 0 ? '+' : ''}${fmt(r.shortfall)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            Shortfall = Daily Needed − Live Daily Budget · Red = underpacing · Green = on track or ahead · Values auto-save · Click <strong>Fetch Spend</strong> to pull current totals from Facebook
          </div>
        </div>
      )}

      {/* ── Daily spend grid ─────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : states.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          No spend data for this month. Click <strong>Sync Month</strong> to fetch it, or run Sync Now on the Ads Tracking tab.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            Drag column headers to reorder · order saves automatically
          </div>
          <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 200px)', border: '1px solid var(--border)', borderRadius: 10 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={dayTh}>Day</th>
                  {states.map(st => (
                    <th
                      key={st}
                      style={thBase}
                      draggable
                      onDragStart={() => onDragStart(st)}
                      onDragOver={onDragOver}
                      onDrop={() => onDrop(st)}
                      title="Drag to reorder"
                    >
                      {st}
                    </th>
                  ))}
                  <th style={totTh}>Total</th>
                </tr>
              </thead>
              <tbody>
                {days.map(day => (
                  <tr key={day}>
                    <td style={dayTd}>Day {day}</td>
                    {states.map(st => {
                      const v = grid[day]?.[st] || 0;
                      return (
                        <td key={st} style={{ ...td, color: v ? 'var(--text)' : 'var(--text-muted)' }}>
                          {v ? fmt(v) : ''}
                        </td>
                      );
                    })}
                    <td style={{ ...td, fontWeight: 600, borderLeft: '2px solid var(--border)' }}>
                      {rowTotals[day] ? fmt(rowTotals[day]) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={totDay}>Total</td>
                  {states.map(st => (
                    <td key={st} style={totTd}>{fmt(colTotals[st])}</td>
                  ))}
                  <td style={{ ...totTd, borderLeft: '2px solid var(--border)', color: 'var(--green)', fontSize: 13 }}>
                    {fmt(grandTotal)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
