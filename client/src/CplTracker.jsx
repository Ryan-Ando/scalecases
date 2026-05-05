import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const COLORS = [
  '#2563eb','#dc2626','#16a34a','#d97706','#7c3aed',
  '#0891b2','#be123c','#15803d','#b45309','#6d28d9',
  '#0e7490','#db2777','#65a30d','#ea580c','#4f46e5',
];

const fmt$ = v => v == null ? '—' : `$${v.toFixed(2)}`;

function CplTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(p => p.value != null).sort((a, b) => a.value - b.value);
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12, maxHeight: 280, overflowY: 'auto', boxShadow: 'var(--shadow)' }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{label}</div>
      {rows.map(p => (
        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 20, marginBottom: 2 }}>
          <span style={{ color: 'var(--text)' }}>{p.dataKey}</span>
          <span style={{ fontWeight: 600, color: p.stroke }}>{fmt$(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function CplTracker() {
  const [cplData, setCplData] = useState(null);
  const [leads, setLeads]     = useState({});
  const [hidden, setHidden]   = useState(new Set());
  const [days, setDays]       = useState(14);
  const [phase, setPhase]     = useState('loading'); // 'loading' | 'ready' | 'syncing' | 'error'
  const [error, setError]     = useState(null);

  // Load both spend data and leads from server on mount
  const fetchData = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const [dataRes, leadsRes] = await Promise.all([
        fetch(`${BASE}/api/hyros/cpl-data`).then(r => r.json()),
        fetch(`${BASE}/api/hyros/cpl-leads`).then(r => r.json()),
      ]);
      if (dataRes.ok)  setCplData(dataRes.data);
      if (leadsRes.ok) setLeads(leadsRes.leads);
      setPhase(dataRes.ok ? 'ready' : 'error');
      if (!dataRes.ok) setError(dataRes.error || 'No data yet');
    } catch (e) {
      setError(e.message);
      setPhase('error');
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const runSync = useCallback(async () => {
    setPhase('syncing');
    setError(null);
    try {
      const kickoff = await (await fetch(`${BASE}/api/hyros/sync-cpl`)).json();
      if (!kickoff.ok && kickoff.error !== 'CPL sync already running') {
        throw new Error(kickoff.error || 'Failed to start sync');
      }
      await new Promise((resolve, reject) => {
        const iv = setInterval(async () => {
          try {
            const s = await (await fetch(`${BASE}/api/hyros/sync-cpl-status`)).json();
            if (!s.running) {
              clearInterval(iv);
              s.error ? reject(new Error(s.error)) : resolve();
            }
          } catch (e) { clearInterval(iv); reject(e); }
        }, 2500);
      });
      await fetchData();
    } catch (e) {
      setError(e.message);
      setPhase(cplData ? 'ready' : 'error');
    }
  }, [fetchData, cplData]);

  // Save a lead to server; optimistically update local state
  const setLead = useCallback((camp, date, raw) => {
    const val = Math.max(0, parseInt(raw, 10) || 0);
    const key = `${camp}|${date}`;
    setLeads(prev => {
      const next = { ...prev, [key]: val };
      if (val === 0) delete next[key];
      return next;
    });
    fetch(`${BASE}/api/hyros/cpl-leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: val }),
    }).catch(() => {});
  }, []);

  const toggle = useCallback(name => {
    setHidden(prev => {
      const s = new Set(prev);
      s.has(name) ? s.delete(name) : s.add(name);
      return s;
    });
  }, []);

  const visDates = useMemo(() => {
    if (!cplData) return [];
    return days > 0 ? cplData.dates.slice(0, days) : cplData.dates;
  }, [cplData, days]);

  const chartData = useMemo(() => {
    if (!cplData) return [];
    return [...visDates].reverse().map(date => {
      const pt = { date };
      for (const c of cplData.campaigns) {
        const spend = cplData.spend[c]?.[date] || 0;
        const l = leads[`${c}|${date}`] || 0;
        pt[c] = l > 0 ? +(spend / l).toFixed(2) : null;
      }
      return pt;
    });
  }, [cplData, leads, visDates]);

  const syncing = phase === 'syncing';

  if (phase === 'loading') {
    return <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading CPL data…</div>;
  }

  if (!cplData) {
    return (
      <div style={{ padding: 40 }}>
        <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
          {error || 'No data yet.'} Click Sync CPL to load.
        </p>
        <button onClick={runSync} disabled={syncing} className="cpl-sync-btn">
          {syncing ? 'Syncing…' : '↻ Sync CPL'}
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
        <button onClick={runSync} disabled={syncing} className="cpl-sync-btn">
          {syncing ? 'Syncing…' : '↻ Sync CPL'}
        </button>
        {cplData.lastSync && (
          <span className="cpl-lastsync">Last synced: {new Date(cplData.lastSync).toLocaleString()}</span>
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
              <th rowSpan={2} className="cpl-th-camp">Campaign</th>
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
            {cplData.campaigns.map((camp, ci) => {
              const totSpend = visDates.reduce((s, d) => s + (cplData.spend[camp]?.[d] || 0), 0);
              const totLeads = visDates.reduce((s, d) => s + (leads[`${camp}|${d}`] || 0), 0);
              const totCpl   = totLeads > 0 ? totSpend / totLeads : null;
              const alt = ci % 2 === 1;
              return (
                <tr key={camp} className={alt ? 'cpl-row-alt' : ''}>
                  <td className={`cpl-td-camp${alt ? ' alt' : ''}`} title={camp}>{camp}</td>
                  {visDates.map(date => {
                    const spend = cplData.spend[camp]?.[date] || 0;
                    const l = leads[`${camp}|${date}`] || 0;
                    const cpl = l > 0 ? spend / l : null;
                    return (
                      <Fragment key={date}>
                        <td className="cpl-td cpl-td-spend">{spend > 0 ? fmt$(spend) : '—'}</td>
                        <td className="cpl-td cpl-td-leads">
                          <input
                            type="number" min="0"
                            value={l || ''} placeholder="0"
                            onChange={e => setLead(camp, date, e.target.value)}
                            className="cpl-input"
                          />
                        </td>
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
                const dayLeads = cplData.campaigns.reduce((s, c) => s + (leads[`${c}|${date}`] || 0), 0);
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
                const totLeads = visDates.reduce((s, d) => s + cplData.campaigns.reduce((ss, c) => ss + (leads[`${c}|${d}`] || 0), 0), 0);
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
                {c}
              </button>
            );
          })}
        </div>
        <ResponsiveContainer width="100%" height={380}>
          <LineChart data={chartData} margin={{ top: 4, right: 24, bottom: 4, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} />
            <YAxis tickFormatter={v => `$${v}`} tick={{ fontSize: 11, fill: 'var(--text-muted)' }} width={64} />
            <Tooltip content={<CplTooltip />} />
            {cplData.campaigns.map((c, i) => (
              <Line
                key={c} type="linear" dataKey={c}
                stroke={COLORS[i % COLORS.length]}
                hide={hidden.has(c)}
                dot={false} strokeWidth={1.5}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
