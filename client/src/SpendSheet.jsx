import { useState, useEffect, useMemo } from 'react';
import { dbGetAll } from './db.js';

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

function extractState(campaignName) {
  if (!campaignName) return null;
  const tokens = (campaignName || '').trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i].toUpperCase();
    if (US_STATES.has(t)) return t;
  }
  return null;
}

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export default function SpendSheet() {
  const [insights, setInsights]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [viewYear, setViewYear]   = useState(new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(new Date().getMonth()); // 0-indexed

  useEffect(() => {
    dbGetAll('fbDailyInsights').then(data => { setInsights(data); setLoading(false); });
  }, []);

  // Filter to the selected month and extract state spend
  const { states, days, grid, rowTotals, colTotals, grandTotal } = useMemo(() => {
    const monthStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}`;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

    // Collect spend: grid[day][state] = spend
    const grid = {};
    const stateSet = new Set();

    for (const row of insights) {
      if (!row.date_start || !row.date_start.startsWith(monthStr)) continue;
      const state = extractState(row.campaign_name);
      if (!state) continue;
      const day = parseInt(row.date_start.slice(8), 10);
      const spend = parseFloat(row.spend) || 0;
      if (!grid[day]) grid[day] = {};
      grid[day][state] = (grid[day][state] || 0) + spend;
      stateSet.add(state);
    }

    const states = [...stateSet].sort();
    const days   = Array.from({ length: daysInMonth }, (_, i) => i + 1);

    // Row totals (total spend per day)
    const rowTotals = {};
    for (const day of days) {
      rowTotals[day] = states.reduce((s, st) => s + (grid[day]?.[st] || 0), 0);
    }

    // Column totals (total spend per state for the month)
    const colTotals = {};
    for (const st of states) {
      colTotals[st] = days.reduce((s, day) => s + (grid[day]?.[st] || 0), 0);
    }

    const grandTotal = states.reduce((s, st) => s + colTotals[st], 0);

    return { states, days, grid, rowTotals, colTotals, grandTotal };
  }, [insights, viewYear, viewMonth]);

  function prevMonth() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(y => y - 1); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(y => y + 1); }
    else setViewMonth(m => m + 1);
  }

  function fmt(v) {
    if (!v) return '';
    return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const thStyle = {
    position: 'sticky', top: 0, zIndex: 2,
    background: 'var(--surface)', borderBottom: '2px solid var(--border)',
    padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
    letterSpacing: '0.05em', color: 'var(--text-muted)', textAlign: 'right', whiteSpace: 'nowrap',
  };
  const dayThStyle = { ...thStyle, textAlign: 'left', position: 'sticky', left: 0, zIndex: 3, minWidth: 60 };
  const tdStyle = { padding: '6px 10px', fontSize: 12, textAlign: 'right', borderBottom: '1px solid var(--border)', color: 'var(--text)' };
  const dayTdStyle = { ...tdStyle, textAlign: 'left', position: 'sticky', left: 0, zIndex: 1, background: 'var(--surface)', fontWeight: 600, color: 'var(--text-muted)' };
  const totalRowStyle = { ...tdStyle, fontWeight: 700, background: 'var(--bg)', borderTop: '2px solid var(--border)' };
  const totalDayStyle = { ...dayTdStyle, fontWeight: 700, background: 'var(--bg)', borderTop: '2px solid var(--border)' };

  return (
    <div style={{ padding: '24px 28px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Spend Sheet</div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="btn btn--sm" onClick={prevMonth}>‹</button>
          <span style={{ fontSize: 14, fontWeight: 600, minWidth: 130, textAlign: 'center' }}>
            {MONTH_NAMES[viewMonth]} {viewYear}
          </span>
          <button className="btn btn--sm" onClick={nextMonth}>›</button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
      ) : states.length === 0 ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No spend data for this month. Run Sync Now on the Ads Tracking tab first.</div>
      ) : (
        <div style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 160px)', border: '1px solid var(--border)', borderRadius: 10 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={dayThStyle}>Day</th>
                {states.map(st => <th key={st} style={thStyle}>{st}</th>)}
                <th style={{ ...thStyle, color: 'var(--text)', borderLeft: '2px solid var(--border)' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {days.map(day => {
                const rowHasData = states.some(st => grid[day]?.[st]);
                return (
                  <tr key={day} style={{ background: rowHasData ? undefined : 'transparent' }}>
                    <td style={dayTdStyle}>Day {day}</td>
                    {states.map(st => {
                      const v = grid[day]?.[st] || 0;
                      return (
                        <td key={st} style={{ ...tdStyle, color: v ? 'var(--text)' : 'var(--text-muted)' }}>
                          {v ? fmt(v) : ''}
                        </td>
                      );
                    })}
                    <td style={{ ...tdStyle, fontWeight: 600, borderLeft: '2px solid var(--border)' }}>
                      {rowTotals[day] ? fmt(rowTotals[day]) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td style={totalDayStyle}>Total</td>
                {states.map(st => (
                  <td key={st} style={totalRowStyle}>{fmt(colTotals[st])}</td>
                ))}
                <td style={{ ...totalRowStyle, borderLeft: '2px solid var(--border)', color: 'var(--green)', fontSize: 13 }}>
                  {fmt(grandTotal)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
