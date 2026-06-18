import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';

const BASE    = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const LS_ORDER = 'cpl_row_order';
const COLORS  = [
  '#2563eb','#dc2626','#16a34a','#d97706','#7c3aed',
  '#0891b2','#be123c','#15803d','#b45309','#6d28d9',
  '#0e7490','#db2777','#65a30d','#ea580c','#4f46e5',
];

// Map the days toggle to an FB date_preset. 0 = All ⇒ last 90 days.
const DAYS_TO_PRESET = { 7: 'last_7d', 14: 'last_14d', 30: 'last_30d', 0: 'last_90d' };

const fmt$ = v => v == null ? '—' : `$${v.toFixed(2)}`;

function loadOrder() {
  try { return JSON.parse(localStorage.getItem(LS_ORDER) || 'null'); } catch { return null; }
}
function saveOrder(arr) {
  try { localStorage.setItem(LS_ORDER, JSON.stringify(arr)); } catch {}
}

// Merge saved order with current campaigns: keep saved order, append new, drop removed
function mergeOrder(saved, current) {
  if (!saved) return [...current];
  return [
    ...saved.filter(c => current.includes(c)),
    ...current.filter(c => !saved.includes(c)),
  ];
}

function CplTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(p => p.value != null).sort((a, b) => a.value - b.value);
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12, maxHeight: 280, overflowY: 'auto', boxShadow: 'var(--shadow)' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {rows.map(p => (
        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 20, marginBottom: 2 }}>
          <span style={{ color: 'var(--text)', fontWeight: p.dataKey === '__avg__' ? 700 : 400 }}>
            {p.dataKey === '__avg__' ? 'Avg CPL' : p.dataKey}
          </span>
          <span style={{ fontWeight: 600, color: p.stroke }}>{fmt$(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// Build cplData shape: { dates (newest→oldest), campaigns, spend[c][d], leads[c][d], status[c], lastSync }
function buildCplData(dailyRows, campaignsList) {
  const datesSet = new Set();
  const campsSet = new Set();
  const spend = {};
  const leads = {};
  for (const r of dailyRows) {
    const c = r.campaign_name;
    const d = r.date_start;
    if (!c || !d) continue;
    datesSet.add(d);
    campsSet.add(c);
    if (!spend[c]) { spend[c] = {}; leads[c] = {}; }
    spend[c][d] = (spend[c][d] || 0) + (parseFloat(r.spend) || 0);
    leads[c][d] = (leads[c][d] || 0) + (parseFloat(r.results) || 0);
  }
  const status = {};
  for (const c of campaignsList || []) {
    status[c.name] = (c.effectiveStatus || c.status || '').toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
    campsSet.add(c.name);
  }
  const dates = [...datesSet].sort((a, b) => b.localeCompare(a)); // newest first
  const campaigns = [...campsSet].filter(c => spend[c]).sort();   // skip campaigns with no daily data
  return { dates, campaigns, spend, leads, status, lastSync: new Date().toISOString() };
}

export default function CplTracker() {
  const [cplData, setCplData] = useState(null);
  const [rowOrder, setRowOrder] = useState([]);
  const [hidden, setHidden]   = useState(new Set());
  const [days, setDays]       = useState(14);
  const [phase, setPhase]     = useState('loading');
  const [error, setError]     = useState(null);

  // drag state (refs to avoid re-renders mid-drag)
  const dragIdx  = useRef(null);
  const dragOver = useRef(null);

  const fetchData = useCallback(async (preset) => {
    setPhase('loading');
    setError(null);
    try {
      const datePreset = preset || DAYS_TO_PRESET[days] || 'last_14d';
      const [dailyRes, campsRes] = await Promise.all([
        fetch(`${BASE}/api/facebook/daily?level=campaign&date_preset=${datePreset}`).then(async r => {
          if (!r.ok) throw new Error(`daily: HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${BASE}/api/facebook/campaigns?date_preset=${datePreset}`).then(async r => {
          if (!r.ok) throw new Error(`campaigns: HTTP ${r.status}`);
          return r.json();
        }),
      ]);
      const built = buildCplData(dailyRes, campsRes);
      setCplData(built);
      setRowOrder(prev => {
        const merged = mergeOrder(prev.length ? prev : loadOrder(), built.campaigns);
        saveOrder(merged);
        return merged;
      });
      setPhase('ready');
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  }, [days]);

  // Re-fetch whenever the days window changes
  useEffect(() => { fetchData(); }, [fetchData]);

  const toggle = useCallback(name => {
    setHidden(prev => {
      const s = new Set(prev);
      s.has(name) ? s.delete(name) : s.add(name);
      return s;
    });
  }, []);

  // Drag-and-drop handlers
  const onDragStart = useCallback((i) => { dragIdx.current = i; }, []);
  const onDragEnter = useCallback((i) => { dragOver.current = i; }, []);
  const onDragEnd   = useCallback(() => {
    const from = dragIdx.current;
    const to   = dragOver.current;
    if (from == null || to == null || from === to) { dragIdx.current = null; dragOver.current = null; return; }
    setRowOrder(prev => {
      const next = [...prev];
      next.splice(to, 0, next.splice(from, 1)[0]);
      saveOrder(next);
      return next;
    });
    dragIdx.current  = null;
    dragOver.current = null;
  }, []);

  // visDates: trim to the active days window (FB already filtered upstream but the user
  // can also flip locally without re-fetching).
  const visDates = useMemo(() => {
    if (!cplData) return [];
    return days > 0 ? cplData.dates.slice(0, days) : cplData.dates;
  }, [cplData, days]);

  const chartData = useMemo(() => {
    if (!cplData) return [];
    return [...visDates].reverse().map(date => {
      const pt = { date };
      let totalSpend = 0, totalLeads = 0;
      for (const c of cplData.campaigns) {
        const spend = cplData.spend[c]?.[date] || 0;
        const l = cplData.leads[c]?.[date] || 0;
        pt[c] = l > 0 ? +(spend / l).toFixed(2) : null;
        totalSpend += spend;
        totalLeads += l;
      }
      pt.__avg__ = totalLeads > 0 ? +(totalSpend / totalLeads).toFixed(2) : null;
      return pt;
    });
  }, [cplData, visDates]);

  const yTicks = useMemo(() => {
    if (!chartData.length) return [0, 300, 600, 900];
    const allVals = chartData.flatMap(d =>
      [...(cplData?.campaigns || []), '__avg__'].map(k => d[k] || 0)
    );
    const maxVal  = Math.max(0, ...allVals);
    const maxTick = Math.max(300, Math.ceil(maxVal / 300) * 300);
    return Array.from({ length: maxTick / 300 + 1 }, (_, i) => i * 300);
  }, [chartData, cplData]);

  const loading = phase === 'loading';

  if (loading && !cplData) {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading CPL data from Facebook…</div>;
  }

  if (!cplData) {
    return (
      <div style={{ padding: 40 }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
          {error || 'No data yet.'}
        </p>
        <button onClick={() => fetchData()} disabled={loading} className="cpl-sync-btn">
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        {error && <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="cpl-wrap">
      {/* Toolbar */}
      <div className="cpl-toolbar">
        <span className="cpl-title">CPL Tracker</span>
        <button onClick={() => fetchData()} disabled={loading} className="cpl-sync-btn">
          {loading ? 'Loading…' : '↻ Refresh'}
        </button>
        {cplData.lastSync && (
          <span className="cpl-lastsync">Last refresh: {new Date(cplData.lastSync).toLocaleString()}</span>
        )}
        {error && <span style={{ fontSize: 12, color: '#dc2626' }}>{error}</span>}
        <div className="cpl-days">
          {[7, 14, 30, 0].map(n => (
            <button key={n} onClick={() => setDays(n)} className={`cpl-day-btn${days === n ? ' active' : ''}`}>
              {n === 0 ? 'All' : `${n}D`}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="cpl-table-wrap">
        <table className="cpl-table">
          <thead>
            <tr>
              <th rowSpan={2} className="cpl-th-camp" style={{ paddingLeft: 28 }}>Campaign</th>
              {visDates.map(d => <th key={d} colSpan={3} className="cpl-th-date">{d}</th>)}
              <th colSpan={3} className="cpl-th-total">TOTAL</th>
            </tr>
            <tr>
              {[...visDates, '__tot__'].map(d => (
                <Fragment key={d}>
                  <th className="cpl-mhdr cpl-mhdr-spend">Spend</th>
                  <th className="cpl-mhdr cpl-mhdr-leads">Leads</th>
                  <th className="cpl-mhdr cpl-mhdr-cpl">CPL</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowOrder.map((camp, ci) => {
              const totSpend = visDates.reduce((s, d) => s + (cplData.spend[camp]?.[d] || 0), 0);
              const totLeads = visDates.reduce((s, d) => s + (cplData.leads[camp]?.[d] || 0), 0);
              const totCpl   = totLeads > 0 ? totSpend / totLeads : null;
              const alt = ci % 2 === 1;
              return (
                <tr
                  key={camp}
                  className={alt ? 'cpl-row-alt' : ''}
                  draggable
                  onDragStart={() => onDragStart(ci)}
                  onDragEnter={() => onDragEnter(ci)}
                  onDragEnd={onDragEnd}
                  onDragOver={e => e.preventDefault()}
                  style={{ cursor: 'grab' }}
                >
                  <td className={`cpl-td-camp${alt ? ' alt' : ''}`} title={camp}>
                    <span className="cpl-drag-handle">⠿</span>
                    <span
                      className="cpl-status-dot"
                      title={cplData.status?.[camp] === 'ACTIVE' ? 'Active' : 'Inactive'}
                      style={{ background: cplData.status?.[camp] === 'ACTIVE' ? '#16a34a' : '#9ca3af' }}
                    />
                    {camp}
                  </td>
                  {visDates.map(date => {
                    const spend = cplData.spend[camp]?.[date] || 0;
                    const l = cplData.leads[camp]?.[date] || 0;
                    const cpl = l > 0 ? spend / l : null;
                    return (
                      <Fragment key={date}>
                        <td className="cpl-td cpl-td-spend">{spend > 0 ? fmt$(spend) : '—'}</td>
                        <td className="cpl-td cpl-td-leads">{l || '—'}</td>
                        <td className="cpl-td cpl-td-cpl">{fmt$(cpl)}</td>
                      </Fragment>
                    );
                  })}
                  <td className="cpl-td cpl-td-spend cpl-bold">{fmt$(totSpend)}</td>
                  <td className="cpl-td cpl-td-leads cpl-bold">{totLeads || '—'}</td>
                  <td className="cpl-td cpl-td-cpl cpl-bold">{fmt$(totCpl)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="cpl-row-totals">
              <td className="cpl-td-camp cpl-td-totals-label">TOTAL</td>
              {visDates.map(date => {
                const daySpend = cplData.campaigns.reduce((s, c) => s + (cplData.spend[c]?.[date] || 0), 0);
                const dayLeads = cplData.campaigns.reduce((s, c) => s + (cplData.leads[c]?.[date] || 0), 0);
                const dayCpl   = dayLeads > 0 ? daySpend / dayLeads : null;
                return (
                  <Fragment key={date}>
                    <td className="cpl-td cpl-td-spend cpl-bold">{daySpend > 0 ? fmt$(daySpend) : '—'}</td>
                    <td className="cpl-td cpl-td-leads cpl-bold">{dayLeads || '—'}</td>
                    <td className="cpl-td cpl-td-cpl cpl-bold">{fmt$(dayCpl)}</td>
                  </Fragment>
                );
              })}
              {(() => {
                const totSpend = visDates.reduce((s, d) => s + cplData.campaigns.reduce((ss, c) => ss + (cplData.spend[c]?.[d] || 0), 0), 0);
                const totLeads = visDates.reduce((s, d) => s + cplData.campaigns.reduce((ss, c) => ss + (cplData.leads[c]?.[d] || 0), 0), 0);
                const totCpl   = totLeads > 0 ? totSpend / totLeads : null;
                return (
                  <>
                    <td className="cpl-td cpl-td-spend cpl-bold">{fmt$(totSpend)}</td>
                    <td className="cpl-td cpl-td-leads cpl-bold">{totLeads || '—'}</td>
                    <td className="cpl-td cpl-td-cpl cpl-bold">{fmt$(totCpl)}</td>
                  </>
                );
              })()}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Chart */}
      <div className="cpl-chart-wrap">
        <div className="cpl-chart-hdr">
          <span style={{ fontWeight: 600, fontSize: 14 }}>CPL by Campaign</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Click a campaign to toggle</span>
        </div>
        <div className="cpl-legend">
          {cplData.campaigns.map((c, i) => {
            const off = hidden.has(c);
            const color = COLORS[i % COLORS.length];
            return (
              <button
                key={c} onClick={() => toggle(c)}
                className="cpl-legend-btn"
                style={{
                  borderColor: off ? '#d1d5db' : color,
                  background:  off ? '#f3f4f6' : 'transparent',
                  color:       off ? '#9ca3af' : 'var(--text)',
                }}
              >
                <span className="cpl-ldot" style={{ background: off ? '#d1d5db' : color }} />
                <span
                  className="cpl-status-dot"
                  title={cplData.status?.[c] === 'ACTIVE' ? 'Active' : 'Inactive'}
                  style={{ background: cplData.status?.[c] === 'ACTIVE' ? '#16a34a' : '#9ca3af' }}
                />
                {c}
              </button>
            );
          })}
        </div>
        <ResponsiveContainer width="100%" height={380}>
          <LineChart data={chartData} margin={{ top: 4, right: 24, bottom: 4, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis
              tickFormatter={v => `$${v}`}
              tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
              ticks={yTicks}
              domain={[0, yTicks[yTicks.length - 1]]}
              width={64}
            />
            <Tooltip content={<CplTooltip />} />
            <ReferenceLine y={300} stroke="#dc2626" strokeDasharray="5 4" strokeWidth={1.5} />
            {cplData.campaigns.map((c, i) => (
              <Line
                key={c} type="linear" dataKey={c}
                stroke={COLORS[i % COLORS.length]}
                hide={hidden.has(c)}
                dot={false} strokeWidth={1.5}
                connectNulls={false}
              />
            ))}
            <Line
              type="linear" dataKey="__avg__"
              name="Avg CPL"
              stroke="#000000" strokeWidth={3}
              dot={false} connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
