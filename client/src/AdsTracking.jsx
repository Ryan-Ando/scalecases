import { useState, useMemo, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import api from './api.js';

// Extract 2-letter state abbreviation from campaign name e.g. "LSS - WA" → "WA"
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

const CHART_METRICS = [
  { key: 'leads', label: 'Leads/Day',    color: '#3a8f5c', fmt: v => v },
  { key: 'spend', label: 'Spend/Day',    color: '#6366f1', fmt: v => `$${v}` },
  { key: 'cpm',   label: 'CPM/Day',      color: '#f59e0b', fmt: v => v != null ? `$${v}` : '—' },
  { key: 'cpl',   label: 'Cost/Lead',    color: '#ef4444', fmt: v => v != null ? `$${v}` : '—' },
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

export default function AdsTracking({ ads, ghlContacts, timeframe }) {
  const [accountNames, setAccountNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem('trackingAccountNames') || '{}'); }
    catch { return {}; }
  });
  const [editingState, setEditingState] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [cellDetail, setCellDetail] = useState(null);
  const [dailyData, setDailyData] = useState([]);
  const [chartMetric, setChartMetric] = useState('leads');

  useEffect(() => {
    api.dailyInsights(timeframe)
      .then(setDailyData)
      .catch(err => console.warn('Daily insights unavailable:', err.message));
  }, [timeframe]);

  // Unique states derived from GHL contact campaign names
  const states = useMemo(() => {
    const set = new Set();
    for (const c of ghlContacts) {
      const s = extractState(c.utmCampaign);
      if (s) set.add(s);
    }
    return [...set].sort();
  }, [ghlContacts]);

  // Unique ad names from FB ads (deduped by name)
  const adNames = useMemo(() => {
    const seen = new Set();
    const names = [];
    for (const a of ads) {
      if (a.name && !seen.has(a.name.trim())) {
        seen.add(a.name.trim());
        names.push(a.name.trim());
      }
    }
    return names.sort();
  }, [ads]);

  // Grid: adName → state → [GHL contacts]
  const grid = useMemo(() => {
    const map = {};
    for (const adName of adNames) {
      map[adName] = {};
      for (const state of states) map[adName][state] = [];
    }
    for (const c of ghlContacts) {
      const state = extractState(c.utmCampaign);
      const adName = (c.utmContent || '').trim();
      if (state && adName && map[adName]?.[state] !== undefined) {
        map[adName][state].push(c);
      }
    }
    return map;
  }, [adNames, states, ghlContacts]);

  // Leads per day from GHL contacts
  const leadsPerDay = useMemo(() => {
    const map = {};
    for (const c of ghlContacts) {
      if (!c.dateAdded) continue;
      const day = c.dateAdded.slice(0, 10);
      map[day] = (map[day] || 0) + 1;
    }
    return map;
  }, [ghlContacts]);

  // Combined chart data: FB daily (spend/CPM) merged with GHL leads/day
  const chartData = useMemo(() => {
    const fbMap = {};
    for (const row of dailyData) {
      const date = row.date_start;
      if (!fbMap[date]) fbMap[date] = { spend: 0, cpm_sum: 0, cpm_count: 0 };
      fbMap[date].spend += parseFloat(row.spend) || 0;
      if (row.cpm) { fbMap[date].cpm_sum += parseFloat(row.cpm); fbMap[date].cpm_count++; }
    }
    const allDates = new Set([...Object.keys(fbMap), ...Object.keys(leadsPerDay)]);
    return [...allDates].sort().map(date => {
      const fb = fbMap[date] || {};
      const leads = leadsPerDay[date] || 0;
      const spend = +(fb.spend || 0).toFixed(2);
      const cpm = fb.cpm_count > 0 ? +(fb.cpm_sum / fb.cpm_count).toFixed(2) : null;
      const cpl = leads > 0 && spend > 0 ? +(spend / leads).toFixed(2) : null;
      return { date: date.slice(5), leads, spend, cpm, cpl };
    });
  }, [dailyData, leadsPerDay]);

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

  return (
    <div>
      <div className="tab-header">
        <div className="tab-title">Ads Tracking</div>
        <div className="tab-desc">Leads generated per ad type per account.</div>
      </div>

      {/* Charts */}
      <div style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          {CHART_METRICS.map(m => (
            <button
              key={m.key}
              className={`btn btn--sm${chartMetric === m.key ? ' btn--primary' : ''}`}
              onClick={() => setChartMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div style={{ background: 'var(--surface)', borderRadius: 12, border: '1px solid var(--border)', padding: '20px 8px 8px' }}>
          {chartData.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              No data for selected timeframe
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 4, right: 24, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
                <Tooltip content={<CustomTooltip metricKey={chartMetric} />} />
                <Line
                  type="monotone"
                  dataKey={chartMetric}
                  stroke={activeMetric?.color || '#3a8f5c'}
                  dot={false}
                  strokeWidth={2}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Tracking Grid */}
      {adNames.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">📊</div>
          <div className="empty-title">No ads data</div>
          <div className="empty-desc">Open the Ads tab first so ad names are loaded, then return here.</div>
        </div>
      ) : (
        <div className="tracking-grid-wrap">
          <table className="tracking-grid">
            <thead>
              <tr>
                <th className="tracking-th-ad">Ad Name</th>
                {states.map(state => (
                  <th key={state} className="tracking-th-state">
                    {editingState === state ? (
                      <form
                        style={{ margin: 0 }}
                        onSubmit={e => { e.preventDefault(); saveAccountName(state, editValue); }}
                      >
                        <input
                          autoFocus
                          className="tracking-name-input"
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onBlur={() => saveAccountName(state, editValue)}
                        />
                      </form>
                    ) : (
                      <button
                        className="tracking-acct-name"
                        title="Click to rename"
                        onClick={() => { setEditingState(state); setEditValue(accountNames[state] || state); }}
                      >
                        {accountLabel(state)}
                      </button>
                    )}
                  </th>
                ))}
                <th className="tracking-th-state">Total</th>
              </tr>
            </thead>
            <tbody>
              {adNames.map(adName => {
                const row = grid[adName] || {};
                const total = states.reduce((s, st) => s + (row[st]?.length || 0), 0);
                return (
                  <tr key={adName}>
                    <td className="tracking-td-ad" title={adName}>
                      <span className="tracking-ad-name">{adName}</span>
                    </td>
                    {states.map(state => {
                      const leads = row[state] || [];
                      return (
                        <td key={state} className="tracking-td-cell">
                          {leads.length > 0
                            ? <button className="tracking-cell-btn" onClick={() => setCellDetail({ adName, state, leads })}>
                                {leads.length}
                              </button>
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
                {states.map(state => {
                  const total = adNames.reduce((s, a) => s + (grid[a]?.[state]?.length || 0), 0);
                  return <td key={state} className="tracking-td-total tracking-tfoot-label">{total > 0 ? total : '—'}</td>;
                })}
                <td className="tracking-td-total tracking-tfoot-label">
                  {adNames.reduce((s, a) => s + states.reduce((s2, st) => s2 + (grid[a]?.[st]?.length || 0), 0), 0) || '—'}
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
                  {accountLabel(cellDetail.state)} · {cellDetail.leads.length} lead{cellDetail.leads.length !== 1 ? 's' : ''}
                </div>
              </div>
              <button className="col-mgr-x" onClick={() => setCellDetail(null)}>×</button>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {cellDetail.leads.map(c => (
                <div key={c.id} className="case-item">
                  <div className="case-item-name">{c.name}</div>
                  <div className="case-item-meta">
                    <span>{fmtPhone(c.phone)}</span>
                    {c.dateAdded && (
                      <span>{new Date(c.dateAdded).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
