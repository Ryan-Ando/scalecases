import { useState, useMemo, useRef } from 'react';

const CPL_TARGET = 300;
const CPL_HARD_KILL = 600;
const CPL_SOFT_KILL = 450;

function parseFloatSafe(s) {
  if (s == null || s === '') return null;
  const v = parseFloat(String(s).replace(/[%,$]/g, '').trim());
  return Number.isFinite(v) ? v : null;
}

function parseCsv(text) {
  const lines = [];
  let cur = '', inQ = false, row = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQ) {
      if (c === '"' && next === '"') { cur += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); lines.push(row); cur = ''; row = []; }
      else if (c === '\r') {} else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); lines.push(row); }
  const headers = lines[0];
  return lines.slice(1).filter(r => r.length > 1).map(r => {
    const o = {};
    headers.forEach((h, i) => o[h] = r[i] ?? '');
    return o;
  });
}

function mapRow(r) {
  const spend = parseFloatSafe(r['Amount spent (USD)']) || 0;
  const cpm = parseFloatSafe(r['CPM (cost per 1,000 impressions) (USD)']);
  const uclicks = parseFloatSafe(r['Unique link clicks']) || 0;
  const linkClicks = parseFloatSafe(r['Link clicks']) || 0;
  const impressions = cpm && cpm > 0 ? (spend / cpm) * 1000 : 0;
  const lpv = parseFloatSafe(r['Landing page views']) || 0;
  return {
    name: r['Ad set name'],
    campaign: r['Campaign name'],
    delivery: r['Ad set delivery'],
    budget: parseFloatSafe(r['Ad set budget']),
    spend,
    results: parseFloatSafe(r['Results']) || 0,
    cpl: parseFloatSafe(r['Cost per results']),
    uclicks,
    linkClicks,
    cpulc: parseFloatSafe(r['Cost per unique link click (USD)']),
    cpm,
    impressions,
    uctr: parseFloatSafe(r['Unique CTR (link click-through rate)']),
    hookRate: parseFloatSafe(r['3-second video plays rate per impressions']),
    freq: parseFloatSafe(r['Frequency']) || 0,
    lpv,
    lpvRate: linkClicks > 0 ? (lpv / linkClicks) * 100 : null,
    videoAvgTime: r['Video average play time'],
  };
}

function computeBaselines(rows) {
  const byCamp = {};
  for (const r of rows) {
    const c = r.campaign;
    if (!byCamp[c]) byCamp[c] = { spend: 0, uclicks: 0, impressions: 0, results: 0 };
    byCamp[c].spend += r.spend;
    byCamp[c].uclicks += r.uclicks;
    byCamp[c].impressions += r.impressions;
    byCamp[c].results += r.results;
  }
  const baselines = {};
  for (const [c, d] of Object.entries(byCamp)) {
    baselines[c] = {
      cpulc: d.uclicks > 0 ? d.spend / d.uclicks : null,
      cpm: d.impressions > 0 ? (d.spend / d.impressions) * 1000 : null,
      cpl: d.results > 0 ? d.spend / d.results : null,
      totalSpend: d.spend,
      totalLeads: d.results,
    };
  }
  return baselines;
}

function stageOf(spend) {
  if (spend < 50) return 'pre';
  if (spend < 150) return 'S1';
  if (spend < 300) return 'S2';
  if (spend < 500) return 'S3';
  return 'mature';
}

function quadrant(cpm, cpulc) {
  if (cpm == null || cpulc == null) return null;
  const hiCpm = cpm >= 40;
  const hiCpulc = cpulc >= 3;
  if (!hiCpm && !hiCpulc) return { code: 'LL', label: 'Low CPM · Low CPULC', color: '#16a34a' };
  if (hiCpm && !hiCpulc)  return { code: 'HL', label: 'High CPM · Low CPULC', color: '#16a34a' };
  if (!hiCpm && hiCpulc)  return { code: 'LH', label: 'Low CPM · High CPULC', color: '#f59e0b' };
  return { code: 'HH', label: 'High CPM · High CPULC', color: '#dc2626' };
}

function evaluateKill(r, baseline) {
  const stage = stageOf(r.spend);
  const reasons = [];
  let flag = null;

  // Layer 4 — Safe override: keep if converting well
  if (r.cpl != null && r.cpl <= CPL_TARGET) {
    return { stage, flag: 'safe', reasons: [`CPL $${r.cpl.toFixed(0)} ≤ $${CPL_TARGET} target`] };
  }
  if (r.results >= 3 && r.cpl != null && r.cpl <= CPL_SOFT_KILL) {
    return { stage, flag: 'safe', reasons: [`${r.results} leads at CPL $${r.cpl.toFixed(0)}`] };
  }

  const hard = [];
  const soft = [];

  // Universal hard kills (any spend ≥ $50)
  if (r.spend >= 50 && r.linkClicks === 0) hard.push('0 link clicks at $50+');
  if (r.cpm != null && r.cpm >= 150) hard.push(`CPM $${r.cpm.toFixed(0)} ≥ $150 (universal ceiling)`);

  const baseCpulc = baseline?.cpulc;
  const cpulcMul = baseCpulc && r.cpulc ? (r.cpulc / baseCpulc) : null;

  // Stage rules
  if (stage === 'S1' && r.spend >= 50) {
    // $50-150: CPULC ≥ $10 universal, OR ≥ 4× baseline (whichever lower)
    const threshold = baseCpulc ? Math.min(10, baseCpulc * 4) : 10;
    if (r.cpulc != null && r.cpulc >= threshold) {
      hard.push(`CPULC $${r.cpulc.toFixed(2)} ≥ $${threshold.toFixed(2)} (S1 kill)`);
    }
    if (r.cpulc != null && r.cpulc >= 7 && r.cpm != null && r.cpm >= 60) {
      hard.push(`Combo: CPULC ≥$7 + CPM ≥$60 (S1)`);
    }
  }

  if (stage === 'S2' || stage === 'S3' || stage === 'mature') {
    // $150+: tighter CPULC threshold
    const threshold = baseCpulc ? Math.min(7, baseCpulc * 3) : 7;
    if (r.cpulc != null && r.cpulc >= threshold) {
      hard.push(`CPULC $${r.cpulc.toFixed(2)} ≥ $${threshold.toFixed(2)} (S2+ kill)`);
    }
    if (r.cpulc != null && r.cpulc >= 5 && r.cpm != null && r.cpm >= 60) {
      hard.push(`Combo: CPULC ≥$5 + CPM ≥$60`);
    }
    if (r.uctr != null && r.uctr <= 0.4 && r.cpulc != null && r.cpulc >= 5) {
      hard.push(`UCTR ${r.uctr.toFixed(2)}% ≤ 0.4 + CPULC ≥$5`);
    }
    if (r.spend >= 150 && r.lpv === 0 && r.linkClicks > 0) {
      hard.push(`0 LPVs at $150+ (page broken?)`);
    }
  }

  // Outcome-based
  if (r.spend >= 300 && r.results === 0) {
    hard.push(`$300+ spent, 0 leads`);
  }
  if (r.cpl != null && r.cpl >= CPL_HARD_KILL) {
    hard.push(`CPL $${r.cpl.toFixed(0)} ≥ $${CPL_HARD_KILL} (2× target)`);
  }
  if (r.cpl != null && r.cpl >= CPL_SOFT_KILL && r.cpl < CPL_HARD_KILL) {
    soft.push(`CPL $${r.cpl.toFixed(0)} ≥ $${CPL_SOFT_KILL} (1.5× target)`);
  }

  // Mature decay handled per-row via separate week comparison (not in single CSV)
  if (hard.length) { flag = 'hard'; reasons.push(...hard); }
  else if (soft.length) { flag = 'soft'; reasons.push(...soft); }
  else if (stage === 'pre') { flag = 'pre'; }
  else { flag = 'watch'; }

  return { stage, flag, reasons, cpulcMul };
}

const FLAG_COLORS = {
  hard:  { bg: 'rgba(220,38,38,0.10)', border: '#dc2626', label: 'KILL',  text: '#991b1b' },
  soft:  { bg: 'rgba(245,158,11,0.10)', border: '#f59e0b', label: 'SOFT',  text: '#92400e' },
  watch: { bg: 'transparent',            border: 'transparent', label: '',     text: 'var(--text)' },
  safe:  { bg: 'rgba(34,197,94,0.08)',  border: '#16a34a', label: 'SAFE',  text: '#15803d' },
  pre:   { bg: 'transparent',            border: 'transparent', label: 'NEW',  text: 'var(--text-muted)' },
};

function fmt$(v) { return v == null ? '—' : `$${v.toFixed(v < 10 ? 2 : 0)}`; }
function fmtPct(v) { return v == null ? '—' : `${v.toFixed(2)}%`; }
function fmtNum(v) { return v == null ? '—' : v.toFixed(0); }

export default function KillAnalysis() {
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState('');
  const [filterFlag, setFilterFlag] = useState('all');
  const [filterCamp, setFilterCamp] = useState('all');
  const [filterDelivery, setFilterDelivery] = useState('all');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('spend');
  const [sortDir, setSortDir] = useState('desc');
  const fileRef = useRef(null);

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    Promise.all(files.map(f => f.text())).then(texts => {
      const all = texts.flatMap(parseCsv).map(mapRow).filter(r => r.spend > 0 && r.name);
      setRows(all);
      setFileName(files.map(f => f.name).join(', '));
    });
  }

  const baselines = useMemo(() => computeBaselines(rows), [rows]);

  const enriched = useMemo(() => rows.map(r => {
    const base = baselines[r.campaign];
    const evalRes = evaluateKill(r, base);
    const quad = quadrant(r.cpm, r.cpulc);
    return { ...r, baseline: base, ...evalRes, quad };
  }), [rows, baselines]);

  const campaigns = useMemo(() => [...new Set(enriched.map(r => r.campaign))].sort(), [enriched]);

  const filtered = useMemo(() => {
    let f = enriched;
    if (filterFlag !== 'all') f = f.filter(r => r.flag === filterFlag);
    if (filterCamp !== 'all') f = f.filter(r => r.campaign === filterCamp);
    if (filterDelivery !== 'all') f = f.filter(r => (r.delivery || '').toLowerCase() === filterDelivery);
    if (search) {
      const s = search.toLowerCase();
      f = f.filter(r => r.name.toLowerCase().includes(s) || r.campaign.toLowerCase().includes(s));
    }
    const sorted = [...f].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return sorted;
  }, [enriched, filterFlag, filterCamp, filterDelivery, search, sortKey, sortDir]);

  const totals = useMemo(() => {
    const t = { hard: 0, soft: 0, watch: 0, safe: 0, pre: 0, hardSpend: 0 };
    for (const r of enriched) {
      t[r.flag] = (t[r.flag] || 0) + 1;
      if (r.flag === 'hard') t.hardSpend += r.spend;
    }
    return t;
  }, [enriched]);

  function clickSort(k) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  }

  const th = { padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', borderBottom: '2px solid var(--border)', background: 'var(--surface)', textAlign: 'right', cursor: 'pointer', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2 };
  const thL = { ...th, textAlign: 'left' };
  const td = { padding: '6px 10px', fontSize: 12, textAlign: 'right', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const tdL = { ...td, textAlign: 'left' };

  function SortArrow({ k }) {
    if (sortKey !== k) return null;
    return <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>;
  }

  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Kill Analysis</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Upload FB ad set CSV exports · weekly review</div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".csv" multiple onChange={handleFiles} style={{ display: 'none' }} />
          <button className="btn btn--sm btn--primary" onClick={() => fileRef.current?.click()}>
            Upload CSV{rows.length ? 's (replace)' : ''}
          </button>
          {fileName && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fileName}</span>}
        </div>
      </div>

      {rows.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Upload one or more Facebook ad set CSV exports to begin.<br />
          <span style={{ fontSize: 11 }}>Required columns: Ad set name, Amount spent, Results, Cost per results, Unique link clicks, CPM, Unique CTR, Frequency, Link clicks, Landing page views, Campaign name</span>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Summary strip */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <Pill label="Hard kill" count={totals.hard} sub={`$${totals.hardSpend.toFixed(0)} wasted`} color="#dc2626" active={filterFlag==='hard'} onClick={() => setFilterFlag(filterFlag==='hard'?'all':'hard')} />
            <Pill label="Soft kill" count={totals.soft || 0} color="#f59e0b" active={filterFlag==='soft'} onClick={() => setFilterFlag(filterFlag==='soft'?'all':'soft')} />
            <Pill label="Watch"     count={totals.watch || 0} color="var(--text-muted)" active={filterFlag==='watch'} onClick={() => setFilterFlag(filterFlag==='watch'?'all':'watch')} />
            <Pill label="Safe"      count={totals.safe || 0} color="#16a34a" active={filterFlag==='safe'} onClick={() => setFilterFlag(filterFlag==='safe'?'all':'safe')} />
            <Pill label="New (<$50)" count={totals.pre || 0} color="var(--text-muted)" active={filterFlag==='pre'} onClick={() => setFilterFlag(filterFlag==='pre'?'all':'pre')} />
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <select value={filterCamp} onChange={e => setFilterCamp(e.target.value)} style={selectStyle}>
              <option value="all">All campaigns ({campaigns.length})</option>
              {campaigns.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={filterDelivery} onChange={e => setFilterDelivery(e.target.value)} style={selectStyle}>
              <option value="all">All delivery</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </select>
            <input
              type="text"
              placeholder="Search ad set or campaign…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...selectStyle, minWidth: 220, padding: '5px 9px' }}
            />
            <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
              Showing {filtered.length} of {rows.length} · CPL target ${CPL_TARGET}
            </span>
          </div>

          {/* Campaign baseline reference */}
          <details style={{ marginBottom: 12, fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-muted)', userSelect: 'none' }}>
              Campaign baselines (weighted) — click to expand
            </summary>
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr 90px 90px 90px 100px 80px', gap: '4px 12px', fontVariantNumeric: 'tabular-nums' }}>
              <strong>Campaign</strong><strong style={{textAlign:'right'}}>CPULC</strong><strong style={{textAlign:'right'}}>CPM</strong><strong style={{textAlign:'right'}}>CPL</strong><strong style={{textAlign:'right'}}>Spend</strong><strong style={{textAlign:'right'}}>Leads</strong>
              {campaigns.map(c => {
                const b = baselines[c];
                return (
                  <div key={c} style={{ display: 'contents' }}>
                    <span>{c}</span>
                    <span style={{textAlign:'right'}}>{fmt$(b.cpulc)}</span>
                    <span style={{textAlign:'right'}}>{fmt$(b.cpm)}</span>
                    <span style={{textAlign:'right'}}>{fmt$(b.cpl)}</span>
                    <span style={{textAlign:'right'}}>${b.totalSpend.toFixed(0)}</span>
                    <span style={{textAlign:'right'}}>{b.totalLeads}</span>
                  </div>
                );
              })}
            </div>
          </details>

          {/* Table */}
          <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 280px)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th style={{ ...thL, position: 'sticky', left: 0, zIndex: 3 }}>Flag</th>
                  <th style={thL} onClick={() => clickSort('name')}>Ad set <SortArrow k="name" /></th>
                  <th style={thL} onClick={() => clickSort('campaign')}>Campaign <SortArrow k="campaign" /></th>
                  <th style={th} onClick={() => clickSort('spend')}>Spend <SortArrow k="spend" /></th>
                  <th style={th}>Stage</th>
                  <th style={th}>Quad</th>
                  <th style={th} onClick={() => clickSort('cpulc')}>CPULC <SortArrow k="cpulc" /></th>
                  <th style={th}>× base</th>
                  <th style={th} onClick={() => clickSort('cpm')}>CPM <SortArrow k="cpm" /></th>
                  <th style={th} onClick={() => clickSort('uctr')}>U-CTR <SortArrow k="uctr" /></th>
                  <th style={th} onClick={() => clickSort('freq')}>Freq <SortArrow k="freq" /></th>
                  <th style={th} onClick={() => clickSort('results')}>Leads <SortArrow k="results" /></th>
                  <th style={th} onClick={() => clickSort('cpl')}>CPL <SortArrow k="cpl" /></th>
                  <th style={thL}>Reasons</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const color = FLAG_COLORS[r.flag] || FLAG_COLORS.watch;
                  const cpulcMul = r.baseline?.cpulc && r.cpulc ? r.cpulc / r.baseline.cpulc : null;
                  const cplOverTarget = r.cpl != null && r.cpl > CPL_TARGET;
                  return (
                    <tr key={i} style={{ background: color.bg, borderLeft: `3px solid ${color.border}` }}>
                      <td style={{ ...tdL, position: 'sticky', left: 0, zIndex: 1, background: color.bg, borderLeft: `3px solid ${color.border}` }}>
                        {color.label && <span style={{ background: color.border, color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em' }}>{color.label}</span>}
                      </td>
                      <td style={{ ...tdL, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</td>
                      <td style={{ ...tdL, fontSize: 11, color: 'var(--text-muted)' }}>{r.campaign}</td>
                      <td style={td}>${r.spend.toFixed(0)}</td>
                      <td style={{ ...td, fontSize: 10, color: 'var(--text-muted)' }}>{r.stage}</td>
                      <td style={td}>
                        {r.quad && (
                          <span style={{ background: r.quad.color, color: '#fff', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700 }} title={r.quad.label}>
                            {r.quad.code}
                          </span>
                        )}
                      </td>
                      <td style={td}>{fmt$(r.cpulc)}</td>
                      <td style={{ ...td, color: cpulcMul && cpulcMul >= 3 ? '#dc2626' : cpulcMul && cpulcMul >= 2 ? '#f59e0b' : 'var(--text-muted)', fontWeight: cpulcMul && cpulcMul >= 2 ? 600 : 400 }}>
                        {cpulcMul ? `${cpulcMul.toFixed(1)}×` : '—'}
                      </td>
                      <td style={td}>{fmt$(r.cpm)}</td>
                      <td style={td}>{fmtPct(r.uctr)}</td>
                      <td style={td}>{r.freq ? r.freq.toFixed(2) : '—'}</td>
                      <td style={td}>{fmtNum(r.results)}</td>
                      <td style={{ ...td, color: cplOverTarget ? '#dc2626' : 'var(--text)', fontWeight: cplOverTarget ? 600 : 400 }}>
                        {fmt$(r.cpl)}
                      </td>
                      <td style={{ ...tdL, fontSize: 11, color: color.text, maxWidth: 380, whiteSpace: 'normal' }}>
                        {(r.reasons || []).join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            <strong>Quadrants:</strong> LL=Low CPM + Low CPULC (best) · HL=High CPM + Low CPULC (creative works) · LH=Low CPM + High CPULC (creative weak) · HH=High CPM + High CPULC (worst)
            <br />
            <strong>Rules:</strong> Hard kill if CPULC ≥ $10 ($50+) or ≥ $7 ($150+) · CPM ≥ $150 anywhere · 0 leads at $300+ · CPL ≥ $600 · Safe if CPL ≤ ${CPL_TARGET} target
          </div>
        </>
      )}
    </div>
  );
}

const selectStyle = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', padding: '5px 8px', fontSize: 12, outline: 'none',
};

function Pill({ label, count, sub, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        background: active ? color : 'var(--surface)',
        border: `1px solid ${color === 'var(--text-muted)' ? 'var(--border)' : color}`,
        borderRadius: 8, padding: '8px 14px', cursor: 'pointer',
        color: active ? '#fff' : 'var(--text)', minWidth: 110,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.85 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}>{count}</div>
      {sub && <div style={{ fontSize: 10, opacity: 0.75 }}>{sub}</div>}
    </button>
  );
}
