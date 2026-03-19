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
  if (!v) return '';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function SpendSheet() {
  const [insights, setInsights]   = useState([]);
  const [allAds, setAllAds]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [syncing, setSyncing]     = useState(false);
  const [syncError, setSyncError] = useState('');
  const [viewYear, setViewYear]   = useState(new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(new Date().getMonth());

  // Column order: persisted to localStorage
  const [colOrder, setColOrder] = useState(() => {
    try { const s = localStorage.getItem('spendSheetColOrder'); return s ? JSON.parse(s) : null; }
    catch { return null; }
  });
  const dragSrc = useRef(null);

  function loadFromDB() {
    return Promise.all([
      dbGetAll('fbDailyInsights').then(setInsights),
      dbGetAll('fbAds').then(setAllAds),
    ]);
  }

  useEffect(() => {
    loadFromDB().finally(() => setLoading(false));
  }, []);

  // Live daily budget: sum active adset daily budgets per campaign state
  const budgetByState = useMemo(() => {
    // Deduplicate adsets — one row per unique adset ID so we don't double-count
    // ads that share the same adset
    const seenAdsets = new Set();
    const map = {};
    for (const a of allAds) {
      if (!a.adsetId || seenAdsets.has(a.adsetId)) continue;
      seenAdsets.add(a.adsetId);
      if (a.adsetStatus !== 'ACTIVE') continue;
      const state = extractState(a.campaignName);
      if (!state) continue;
      const budget = parseFloat(a.daily_budget) / 100 || 0; // FB returns cents
      if (budget <= 0) continue;
      map[state] = (map[state] || 0) + budget;
    }
    return map;
  }, [allAds]);

  const budgetStates   = useMemo(() => Object.keys(budgetByState).sort(), [budgetByState]);
  const totalDailyBudget = useMemo(() => Object.values(budgetByState).reduce((s, v) => s + v, 0), [budgetByState]);

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

  // Build grid from insights
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

  // Apply saved order; new states append at end
  const states = useMemo(() => {
    if (!colOrder) return dataStates;
    const ordered = colOrder.filter(s => dataStates.includes(s));
    const added   = dataStates.filter(s => !colOrder.includes(s));
    return [...ordered, ...added];
  }, [dataStates, colOrder]);

  // Drag handlers for column reorder
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

  // Styles
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

      {/* Live Daily Budget section */}
      {budgetStates.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: 'var(--text)' }}>
            Live Daily Budget
            <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: 'var(--text-muted)' }}>
              sum of active adset daily budgets
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
            {budgetStates.map(st => (
              <div key={st} style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '10px 16px',
                minWidth: 90,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{st}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{fmt(budgetByState[st])}</div>
              </div>
            ))}
            <div style={{
              background: 'var(--green-light)',
              border: '1px solid var(--green)',
              borderRadius: 8,
              padding: '10px 16px',
              minWidth: 90,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Total / day</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--green-dark)' }}>{fmt(totalDailyBudget)}</div>
            </div>
          </div>
        </div>
      )}

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
