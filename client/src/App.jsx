import { useState, useMemo, useRef, useEffect } from 'react';
import './App.css';
import api, { mergeCases } from './api.js';


// ─── Column Definitions ────────────────────────────────────────────────────────
const CAMPAIGN_COLS = [
  { key: 'name',                 label: 'Campaign',          src: null,  type: 'name',     vis: true  },
  { key: 'status',               label: 'Delivery',          src: null,  type: 'status',   vis: true  },
  { key: 'budget',               label: 'Budget',            src: null,  type: 'currency', vis: true  },
  { key: 'spend',                label: 'Amount Spent',      src: 'f',   type: 'currency', vis: true  },
  { key: 'results',              label: 'Results',           src: 'f',   type: 'results',  vis: true  },
  { key: 'cost_per_result',      label: 'Cost per Result',   src: '÷',   type: 'currency', vis: true  },
  { key: 'unique_clicks',        label: 'Unique Clicks',     src: 'f',   type: 'number',   vis: true  },
  { key: 'cost_per_unique_click',label: 'Cost / Click',      src: '÷',   type: 'currency', vis: true  },
  { key: 'cpm',                  label: 'CPM',               src: '÷',   type: 'currency', vis: true  },
  { key: 'unique_ctr',           label: 'Unique CTR',        src: '÷',   type: 'percent',  vis: true  },
  { key: 'frequency',            label: 'Frequency',         src: '÷',   type: 'decimal',  vis: false },
  { key: 'video_avg_time',       label: 'Video Play Time',   src: 'f',   type: 'time',     vis: false },
  { key: 'hookRate',             label: 'Hook Rate',         src: '÷',   type: 'percent',  vis: false },
  { key: 'createdTime',          label: 'Date Created',      src: 'f',   type: 'date',     vis: false },
  { key: 'cases',                label: 'Cases',             src: '⟳',   type: 'number',   vis: true  },
  { key: 'costPerCase',          label: 'Cost per Case',     src: '⟳',   type: 'currency', vis: true  },
];

const ADSET_COLS = [
  { key: 'name',                 label: 'Ad Set',            src: null,  type: 'name',     vis: true  },
  { key: 'campaignName',         label: 'Campaign',          src: null,  type: 'text',     vis: true  },
  { key: 'status',               label: 'Delivery',          src: null,  type: 'status',   vis: true  },
  { key: 'budget',               label: 'Budget',            src: null,  type: 'currency', vis: true  },
  { key: 'spend',                label: 'Amount Spent',      src: 'f',   type: 'currency', vis: true  },
  { key: 'results',              label: 'Results',           src: 'f',   type: 'results',  vis: true  },
  { key: 'cost_per_result',      label: 'Cost per Result',   src: '÷',   type: 'currency', vis: true  },
  { key: 'unique_clicks',        label: 'Unique Clicks',     src: 'f',   type: 'number',   vis: true  },
  { key: 'cost_per_unique_click',label: 'Cost / Click',      src: '÷',   type: 'currency', vis: true  },
  { key: 'cpm',                  label: 'CPM',               src: '÷',   type: 'currency', vis: true  },
  { key: 'unique_ctr',           label: 'Unique CTR',        src: '÷',   type: 'percent',  vis: true  },
  { key: 'frequency',            label: 'Frequency',         src: '÷',   type: 'decimal',  vis: false },
  { key: 'audience',             label: 'Audience',          src: null,  type: 'text',     vis: true  },
  { key: 'placement',            label: 'Placement',         src: null,  type: 'text',     vis: false },
  { key: 'createdTime',          label: 'Date Created',      src: 'f',   type: 'date',     vis: false },
];

const AD_COLS = [
  { key: 'name',                 label: 'Ad',                src: null,  type: 'name',     vis: true  },
  { key: 'campaignName',         label: 'Campaign',          src: null,  type: 'text',     vis: true  },
  { key: 'adsetName',            label: 'Ad Set',            src: null,  type: 'text',     vis: true  },
  { key: 'status',               label: 'Delivery',          src: null,  type: 'status',   vis: true  },
  { key: 'format',               label: 'Format',            src: null,  type: 'text',     vis: true  },
  { key: 'spend',                label: 'Amount Spent',      src: 'f',   type: 'currency', vis: true  },
  { key: 'results',              label: 'Results',           src: 'f',   type: 'results',  vis: true  },
  { key: 'cost_per_result',      label: 'Cost per Result',   src: '÷',   type: 'currency', vis: true  },
  { key: 'unique_clicks',        label: 'Unique Clicks',     src: 'f',   type: 'number',   vis: true  },
  { key: 'cost_per_unique_click',label: 'Cost / Click',      src: '÷',   type: 'currency', vis: true  },
  { key: 'cpm',                  label: 'CPM',               src: '÷',   type: 'currency', vis: true  },
  { key: 'unique_ctr',           label: 'Unique CTR',        src: '÷',   type: 'percent',  vis: true  },
  { key: 'video_avg_time',       label: 'Video Play Time',   src: 'f',   type: 'time',     vis: false },
  { key: 'hookRate',             label: 'Hook Rate',         src: '÷',   type: 'percent',  vis: false },
  { key: 'createdTime',          label: 'Date Created',      src: 'f',   type: 'date',     vis: false },
];

const TIMEFRAMES = [
  'Today', 'Yesterday', 'Last 7 Days', 'Last 14 Days',
  'Last 30 Days', 'This Month', 'Last Month', 'Custom Range',
];

// ─── Formatters ────────────────────────────────────────────────────────────────
function fmt(value, type) {
  if (value === null || value === undefined) return '—';
  switch (type) {
    case 'currency':
      return '$' + Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'number':
      return Number(value).toLocaleString('en-US');
    case 'percent':
      return Number(value).toFixed(2) + '%';
    case 'decimal':
      return Number(value).toFixed(2);
    case 'time':
      return Number(value).toFixed(1) + 's';
    case 'date':
      return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    default:
      return String(value);
  }
}

function sum(rows, key) {
  return rows.reduce((acc, r) => acc + (Number(r[key]) || 0), 0);
}

// ─── Logo ──────────────────────────────────────────────────────────────────────
function Logo() {
  return (
    <svg width="26" height="26" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="14" fill="#3a8f5c" />
      <path d="M50 14 L50 86" stroke="white" strokeWidth="8" strokeLinecap="round" />
      <path d="M50 14 L28 36 M50 14 L72 36" stroke="white" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M50 50 L22 68 M50 50 L78 68" stroke="white" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function Calendar({ onApply, initialStart, initialEnd }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [start, setStart] = useState(initialStart || null);
  const [end, setEnd] = useState(initialEnd || null);
  const [hover, setHover] = useState(null);

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  function clickDay(d) {
    const date = new Date(year, month, d);
    if (!start || (start && end)) {
      setStart(date); setEnd(null);
    } else {
      if (date < start) { setEnd(start); setStart(date); }
      else setEnd(date);
    }
  }

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  function classForDay(d) {
    const date = new Date(year, month, d);
    const isStart = start && date.toDateString() === start.toDateString();
    const isEnd = end && date.toDateString() === end.toDateString();
    const isToday = date.toDateString() === today.toDateString();
    const inRange = start && end && date > start && date < end;
    const inHover = start && !end && hover && date > start && date <= hover;
    let cls = 'cal-day';
    if (isStart || isEnd) cls += ' cal-day--selected';
    else if (inRange || inHover) cls += ' cal-day--in-range';
    if (isToday && !isStart && !isEnd) cls += ' cal-day--today';
    return cls;
  }

  function fmtDate(d) {
    if (!d) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div className="calendar-panel">
      <div className="calendar-nav">
        <button className="cal-arrow" onClick={prevMonth}>‹</button>
        <span className="cal-month">{MONTHS[month]} {year}</span>
        <button className="cal-arrow" onClick={nextMonth}>›</button>
      </div>
      <div className="cal-grid">
        {DAYS.map(d => <div key={d} className="cal-dh">{d}</div>)}
        {cells.map((d, i) =>
          d === null
            ? <div key={`e${i}`} className="cal-day cal-day--empty" />
            : <button
                key={d}
                className={classForDay(d)}
                onClick={() => clickDay(d)}
                onMouseEnter={() => setHover(new Date(year, month, d))}
                onMouseLeave={() => setHover(null)}
              >{d}</button>
        )}
      </div>
      <div className="cal-hint">{!start ? 'Click start date' : !end ? 'Click end date' : ''}</div>
      <div className="cal-range-display">
        <div className="cal-date-box">{fmtDate(start)}</div>
        <span className="cal-sep">→</span>
        <div className="cal-date-box">{fmtDate(end)}</div>
      </div>
      <button
        className="cal-apply"
        disabled={!start || !end}
        onClick={() => onApply(start, end)}
      >Apply Range</button>
    </div>
  );
}

// ─── Timeframe Selector ────────────────────────────────────────────────────────
function TimeframeSelector({ value, customStart, customEnd, onChange, onCustomApply }) {
  const [open, setOpen] = useState(false);
  const [showCal, setShowCal] = useState(false);
  const ref = useRef(null);

  function select(tf) {
    if (tf === 'Custom Range') {
      setOpen(false);
      setShowCal(true);
    } else {
      onChange(tf);
      setOpen(false);
      setShowCal(false);
    }
  }

  function applyCustom(s, e) {
    onCustomApply(s, e);
    setShowCal(false);
  }

  const label = value === 'Custom Range' && customStart && customEnd
    ? `${customStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${customEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : value;

  return (
    <div className="timeframe-wrap" ref={ref}>
      <button className="timeframe-btn" onClick={() => { setOpen(o => !o); setShowCal(false); }}>
        📅 {label} <span className="timeframe-caret">▾</span>
      </button>
      {open && (
        <div className="timeframe-dropdown">
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              className={`timeframe-option${value === tf ? ' timeframe-option--active' : ''}`}
              onClick={() => select(tf)}
            >{tf}</button>
          ))}
        </div>
      )}
      {showCal && (
        <Calendar
          onApply={applyCustom}
          initialStart={customStart}
          initialEnd={customEnd}
        />
      )}
    </div>
  );
}

// ─── Column Manager ────────────────────────────────────────────────────────────
function ColumnManager({ cols, onUpdate, onClose }) {
  const [items, setItems] = useState(cols.map(c => ({ ...c })));
  const dragIdx = useRef(null);

  function toggleVis(key) {
    setItems(prev => prev.map(c => c.key === key ? { ...c, vis: !c.vis } : c));
  }

  function onDragStart(i) { dragIdx.current = i; }
  function onDragOver(e, i) {
    e.preventDefault();
    setItems(prev => {
      if (dragIdx.current === null || dragIdx.current === i) return prev;
      const next = [...prev];
      const [moved] = next.splice(dragIdx.current, 1);
      next.splice(i, 0, moved);
      dragIdx.current = i;
      return next;
    });
  }
  function onDrop() { dragIdx.current = null; onUpdate(items); }

  return (
    <div className="col-mgr-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="col-mgr-panel">
        <div className="col-mgr-head">
          <span className="col-mgr-title">Columns</span>
          <button className="col-mgr-x" onClick={onClose}>×</button>
        </div>
        <div className="col-mgr-list">
          {items.map((col, i) => (
            <div
              key={col.key}
              className="col-mgr-item"
              draggable
              onDragStart={() => onDragStart(i)}
              onDragOver={e => onDragOver(e, i)}
              onDrop={onDrop}
            >
              <span className="col-mgr-grip">⠿</span>
              <input
                type="checkbox"
                className="col-mgr-check"
                checked={col.vis}
                onChange={() => toggleVis(col.key)}
              />
              <span className="col-mgr-label">{col.label}</span>
              {col.src && <span className="col-mgr-src">{col.src}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Data Table ────────────────────────────────────────────────────────────────
function DataTable({ data, colDef, showCases }) {
  const [cols, setCols] = useState(() => colDef.filter(c => !(!showCases && (c.key === 'cases' || c.key === 'costPerCase'))));
  const [sortKey, setSortKey] = useState('spend');
  const [sortDir, setSortDir] = useState('desc');
  const [toggles, setToggles] = useState({});
  const [showMgr, setShowMgr] = useState(false);
  const dragColIdx = useRef(null);
  const [dragOverCol, setDragOverCol] = useState(null);

  const visibleCols = cols.filter(c => c.vis);

  function handleSort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  const sorted = useMemo(() => {
    return [...data].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [data, sortKey, sortDir]);

  function onHeaderDragStart(i) { dragColIdx.current = i; }
  function onHeaderDragOver(e, i) { e.preventDefault(); setDragOverCol(i); }
  function onHeaderDrop(i) {
    if (dragColIdx.current === null || dragColIdx.current === i) {
      dragColIdx.current = null; setDragOverCol(null); return;
    }
    setCols(prev => {
      const visible = prev.filter(c => c.vis);
      const hidden = prev.filter(c => !c.vis);
      const [moved] = visible.splice(dragColIdx.current, 1);
      visible.splice(i, 0, moved);
      return [...visible, ...hidden];
    });
    dragColIdx.current = null;
    setDragOverCol(null);
  }

  function renderCell(row, col) {
    const v = row[col.key];
    switch (col.type) {
      case 'name':
        return <td key={col.key} className="td-name">{v ?? '—'}</td>;
      case 'status':
        return (
          <td key={col.key}>
            <span className={`s-badge s-badge--${(v || '').toLowerCase()}`}>
              {v === 'ACTIVE' ? 'Active' : 'Paused'}
            </span>
          </td>
        );
      case 'results':
        return (
          <td key={col.key} className="td-mono">
            <div>{fmt(v, 'number')}</div>
            {row.resultType && <div className="td-sub">{row.resultType}</div>}
          </td>
        );
      default:
        return (
          <td key={col.key} className="td-mono">
            {fmt(v, col.type)}
          </td>
        );
    }
  }

  // Totals
  function totalsCell(col) {
    if (col.type === 'name') return <td key={col.key} className="td-name">Totals</td>;
    if (col.type === 'status' || col.type === 'text') return <td key={col.key} />;
    if (col.type === 'results') return <td key={col.key} className="td-mono">{fmt(sum(sorted, col.key), 'number')}</td>;

    const sumKeys = ['spend', 'budget', 'unique_clicks', 'cases'];
    const avgKeys = ['cpm', 'unique_ctr', 'frequency', 'cost_per_unique_click', 'hookRate'];

    if (sumKeys.includes(col.key)) {
      return <td key={col.key} className="td-mono">{fmt(sum(sorted, col.key), col.type)}</td>;
    }
    if (col.key === 'cost_per_result') {
      const s = sum(sorted, 'spend');
      const r = sum(sorted, 'results');
      return <td key={col.key} className="td-mono">{r > 0 ? fmt(s / r, 'currency') : '—'}</td>;
    }
    if (col.key === 'costPerCase') {
      const s = sum(sorted, 'spend');
      const c = sum(sorted, 'cases');
      return <td key={col.key} className="td-mono">{c > 0 ? fmt(s / c, 'currency') : '—'}</td>;
    }
    if (avgKeys.includes(col.key)) {
      const vals = sorted.map(r => r[col.key]).filter(v => v !== null && v !== undefined);
      const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      return <td key={col.key} className="td-mono">{fmt(avg, col.type)}</td>;
    }
    return <td key={col.key} />;
  }

  return (
    <div style={{ position: 'relative' }}>
      {showMgr && (
        <ColumnManager
          cols={cols}
          onUpdate={updated => { setCols(updated); setShowMgr(false); }}
          onClose={() => setShowMgr(false)}
        />
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button className="btn" onClick={() => setShowMgr(true)}>⊞ Columns</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 48 }} />
              {visibleCols.map((col, i) => (
                <th
                  key={col.key}
                  className={`sortable${dragOverCol === i ? ' th-drag-over' : ''}`}
                  draggable
                  onDragStart={() => onHeaderDragStart(i)}
                  onDragOver={e => onHeaderDragOver(e, i)}
                  onDrop={() => onHeaderDrop(i)}
                  onClick={() => handleSort(col.key)}
                >
                  <div className="th-inner">
                    <span className="th-grip" onClick={e => e.stopPropagation()}>⠿</span>
                    {col.label}
                    {col.src && (
                      <span className={`src-badge${col.src === '⟳' ? ' src-badge--cross' : ''}`}>
                        {col.src}
                      </span>
                    )}
                    {sortKey === col.key && (
                      <span className="sort-arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map(row => (
              <tr key={row.id}>
                <td style={{ textAlign: 'center' }}>
                  <button
                    className={`toggle${toggles[row.id] ?? row.status === 'ACTIVE' ? ' toggle--on' : ''}`}
                    onClick={() => setToggles(t => ({ ...t, [row.id]: !(t[row.id] ?? row.status === 'ACTIVE') }))}
                  />
                </td>
                {visibleCols.map(col => renderCell(row, col))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td />
              {visibleCols.map(col => totalsCell(col))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ─── KPI Strip ─────────────────────────────────────────────────────────────────
function KPIStrip({ data }) {
  const spend      = sum(data, 'spend');
  const impressions = sum(data, 'impressions');
  const clicks     = sum(data, 'unique_clicks');
  const leads      = sum(data, 'results');
  const cases      = sum(data, 'cases');
  const cpl        = leads  > 0 ? spend / leads  : null;
  const cpc        = cases  > 0 ? spend / cases  : null;

  const kpis = [
    { label: 'Spend',        value: fmt(spend, 'currency')       },
    { label: 'Impressions',  value: fmt(impressions, 'number')   },
    { label: 'Clicks',       value: fmt(clicks, 'number')        },
    { label: 'Leads',        value: fmt(leads, 'number')         },
    { label: 'Cost / Lead',  value: fmt(cpl, 'currency')         },
    { label: 'Cases',        value: fmt(cases, 'number')         },
    { label: 'Cost / Case',  value: fmt(cpc, 'currency')         },
  ];

  return (
    <div className="kpi-strip">
      {kpis.map(k => (
        <div key={k.label} className="kpi-card">
          <div className="kpi-value">{k.value}</div>
          <div className="kpi-label">{k.label}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Reports Tab ───────────────────────────────────────────────────────────────
const SAMPLE_REPORTS = [
  { id: 1, title: 'Weekly Performance', meta: 'Last run: Mon Mar 3, 2026 · Scheduled weekly', },
  { id: 2, title: 'Cost per Case by Campaign', meta: 'Last run: Mar 1, 2026 · Manual', },
  { id: 3, title: 'Monthly Spend Summary', meta: 'Last run: Mar 1, 2026 · Scheduled monthly', },
];

function ReportsTab() {
  return (
    <div>
      <div className="tab-header">
        <div className="tab-title">Reports</div>
        <div className="tab-desc">Saved and scheduled performance reports.</div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <button className="btn btn--primary">+ New Report</button>
      </div>
      <div className="reports-grid">
        {SAMPLE_REPORTS.map(r => (
          <div key={r.id} className="report-card">
            <div className="report-card-title">{r.title}</div>
            <div className="report-card-meta">{r.meta}</div>
            <div className="report-card-actions">
              <button className="btn btn--sm btn--primary">Run</button>
              <button className="btn btn--sm">Edit</button>
              <button className="btn btn--sm">Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sources Tab ───────────────────────────────────────────────────────────────
const SOURCES = [
  {
    id: 'fb', icon: '🟦', iconCls: 'source-icon--fb',
    name: 'Facebook Ads', desc: 'Pull campaign, ad set, and ad performance data via Marketing API.',
    status: 'connected', statusLabel: 'Connected',
  },
  {
    id: 'sheets', icon: '🟩', iconCls: 'source-icon--sheets',
    name: 'Google Sheets', desc: 'Map case intake data to campaigns by campaign name.',
    status: 'pending', statusLabel: 'Needs configuration',
  },
  {
    id: 'hubspot', icon: '🟧', iconCls: 'source-icon--hubspot',
    name: 'HubSpot', desc: 'Sync contacts and deals from your CRM.',
    status: 'off', statusLabel: 'Not connected',
  },
  {
    id: 'make', icon: '🟪', iconCls: 'source-icon--make',
    name: 'make.com', desc: 'Push data into Scale Cases via make.com webhooks.',
    status: 'off', statusLabel: 'Not connected',
  },
  {
    id: 'webhook', icon: '⬡', iconCls: 'source-icon--webhook',
    name: 'Custom Webhook', desc: 'Accept any JSON payload from external tools.',
    status: 'off', statusLabel: 'Not connected',
  },
];

function SourcesTab() {
  return (
    <div>
      <div className="tab-header">
        <div className="tab-title">Data Sources</div>
        <div className="tab-desc">Connect and manage the data sources that power your dashboard.</div>
      </div>
      <div className="sources-grid">
        {SOURCES.map(s => (
          <div key={s.id} className="source-card">
            <div className="source-card-top">
              <div className={`source-icon ${s.iconCls}`}>{s.icon}</div>
              <div>
                <div className="source-name">{s.name}</div>
                <div className="source-desc">{s.desc}</div>
              </div>
            </div>
            <div className="source-status">
              <span className={`s-dot s-dot--${s.status === 'connected' ? 'on' : s.status === 'pending' ? 'pending' : 'off'}`} />
              {s.statusLabel}
            </div>
            <div className="source-footer">
              {s.status === 'connected'
                ? <><button className="btn btn--sm">Configure</button><button className="btn btn--sm">Sync Now</button></>
                : s.status === 'pending'
                ? <button className="btn btn--sm btn--primary">Configure</button>
                : <button className="btn btn--sm btn--primary">Connect</button>
              }
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Settings Tab ──────────────────────────────────────────────────────────────
const SETTINGS_SECTIONS = ['General', 'Facebook Ads', 'Google Sheets', 'Notifications'];

function SettingsTab() {
  const [section, setSection] = useState('General');
  const [vals, setVals] = useState({
    timezone: 'America/New_York',
    currency: 'USD',
    syncInterval: '15',
    fbAccount: '',
    sheetsId: '',
    sheetsTab: 'Sheet1',
    campaignCol: 'A',
    casesCol: 'B',
  });

  function set(k, v) { setVals(p => ({ ...p, [k]: v })); }

  return (
    <div>
      <div className="tab-header">
        <div className="tab-title">Settings</div>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav">
          {SETTINGS_SECTIONS.map(s => (
            <button
              key={s}
              className={`settings-nav-item${section === s ? ' settings-nav-item--active' : ''}`}
              onClick={() => setSection(s)}
            >{s}</button>
          ))}
        </nav>
        <div className="settings-panel">
          {section === 'General' && (
            <>
              <div className="settings-section-title">General</div>
              <div className="settings-field">
                <label className="settings-label">Timezone</label>
                <select className="settings-select" value={vals.timezone} onChange={e => set('timezone', e.target.value)}>
                  <option value="America/New_York">Eastern Time (ET)</option>
                  <option value="America/Chicago">Central Time (CT)</option>
                  <option value="America/Denver">Mountain Time (MT)</option>
                  <option value="America/Los_Angeles">Pacific Time (PT)</option>
                </select>
              </div>
              <div className="settings-field">
                <label className="settings-label">Currency</label>
                <select className="settings-select" value={vals.currency} onChange={e => set('currency', e.target.value)}>
                  <option value="USD">USD — US Dollar</option>
                  <option value="EUR">EUR — Euro</option>
                  <option value="GBP">GBP — British Pound</option>
                </select>
              </div>
              <div className="settings-field">
                <label className="settings-label">Auto-sync Interval</label>
                <select className="settings-select" value={vals.syncInterval} onChange={e => set('syncInterval', e.target.value)}>
                  <option value="5">Every 5 minutes</option>
                  <option value="15">Every 15 minutes</option>
                  <option value="30">Every 30 minutes</option>
                  <option value="60">Every hour</option>
                </select>
              </div>
              <button className="btn btn--primary">Save</button>
            </>
          )}
          {section === 'Facebook Ads' && (
            <>
              <div className="settings-section-title">Facebook Ads</div>
              <div className="settings-field">
                <label className="settings-label">Ad Account ID</label>
                <input className="settings-input" placeholder="act_XXXXXXXXXX" value={vals.fbAccount} onChange={e => set('fbAccount', e.target.value)} />
              </div>
              <div className="settings-field">
                <label className="settings-label">Access Token</label>
                <input className="settings-input settings-input--mono" type="password" placeholder="Set in server .env" readOnly />
              </div>
              <button className="btn btn--primary">Save</button>
            </>
          )}
          {section === 'Google Sheets' && (
            <>
              <div className="settings-section-title">Google Sheets</div>
              <div className="settings-field">
                <label className="settings-label">Spreadsheet ID</label>
                <input className="settings-input settings-input--mono" placeholder="From spreadsheet URL" value={vals.sheetsId} onChange={e => set('sheetsId', e.target.value)} />
              </div>
              <div className="settings-field">
                <label className="settings-label">Tab Name</label>
                <input className="settings-input" value={vals.sheetsTab} onChange={e => set('sheetsTab', e.target.value)} />
              </div>
              <div className="settings-field">
                <label className="settings-label">Campaign Name Column</label>
                <input className="settings-input" style={{ maxWidth: 100 }} value={vals.campaignCol} onChange={e => set('campaignCol', e.target.value)} />
              </div>
              <div className="settings-field">
                <label className="settings-label">Cases Column</label>
                <input className="settings-input" style={{ maxWidth: 100 }} value={vals.casesCol} onChange={e => set('casesCol', e.target.value)} />
              </div>
              <button className="btn btn--primary">Save</button>
            </>
          )}
          {section === 'Notifications' && (
            <>
              <div className="settings-section-title">Notifications</div>
              <div className="empty">
                <div className="empty-icon">🔔</div>
                <div className="empty-title">Coming soon</div>
                <div className="empty-desc">Email and Slack alerts for spend thresholds and sync failures.</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── App ───────────────────────────────────────────────────────────────────────
const TABS = ['Campaigns', 'Ad Sets', 'Ads', 'Reports', 'Sources', 'Settings'];

export default function App() {
  const [tab, setTab] = useState('Campaigns');
  const [timeframe, setTimeframe] = useState('Last 30 Days');
  const [customStart, setCustomStart] = useState(null);
  const [customEnd, setCustomEnd] = useState(null);
  const [statusFilter, setStatusFilter] = useState('ALL');

  const [campaigns, setCampaigns] = useState([]);
  const [adsets, setAdsets] = useState([]);
  const [ads, setAds] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const tableTab = tab === 'Campaigns' || tab === 'Ad Sets' || tab === 'Ads';
    if (!tableTab) return;

    setLoading(true);
    setError(null);

    const fetches = {
      'Campaigns': () =>
        Promise.all([api.campaigns(timeframe), api.cases()])
          .then(([data, casesData]) => setCampaigns(mergeCases(data, casesData))),
      'Ad Sets': () =>
        api.adsets(timeframe).then(setAdsets),
      'Ads': () =>
        api.ads(timeframe).then(setAds),
    };

    fetches[tab]()
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [tab, timeframe]);

  function applyCustom(s, e) {
    setCustomStart(s);
    setCustomEnd(e);
    setTimeframe('Custom Range');
  }

  function filter(data) {
    if (statusFilter === 'ALL') return data;
    return data.filter(r => r.status === statusFilter);
  }

  const showTable = tab === 'Campaigns' || tab === 'Ad Sets' || tab === 'Ads';

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <Logo />
          Scale Cases
        </div>
        <nav className="nav">
          {TABS.map(t => (
            <button
              key={t}
              className={`nav-tab${tab === t ? ' nav-tab--active' : ''}`}
              onClick={() => setTab(t)}
            >{t}</button>
          ))}
        </nav>
      </header>

      <main className="content">
        {showTable && (
          <div className="controls">
            <TimeframeSelector
              value={timeframe}
              customStart={customStart}
              customEnd={customEnd}
              onChange={setTimeframe}
              onCustomApply={applyCustom}
            />
            <div className="status-filter">
              {['ALL', 'ACTIVE', 'PAUSED'].map(s => (
                <button
                  key={s}
                  className={`status-btn${statusFilter === s ? ' status-btn--active' : ''}`}
                  onClick={() => setStatusFilter(s)}
                >{s}</button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#991b1b', fontSize: 13 }}>
            Error: {error}
          </div>
        )}

        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
            Loading…
          </div>
        )}

        {!loading && tab === 'Campaigns' && (
          <>
            <KPIStrip data={filter(campaigns)} />
            <DataTable data={filter(campaigns)} colDef={CAMPAIGN_COLS} showCases={true} />
          </>
        )}

        {!loading && tab === 'Ad Sets' && (
          <DataTable data={filter(adsets)} colDef={ADSET_COLS} showCases={false} />
        )}

        {!loading && tab === 'Ads' && (
          <DataTable data={filter(ads)} colDef={AD_COLS} showCases={false} />
        )}

        {tab === 'Reports'  && <ReportsTab />}
        {tab === 'Sources'  && <SourcesTab />}
        {tab === 'Settings' && <SettingsTab />}
      </main>
    </div>
  );
}
