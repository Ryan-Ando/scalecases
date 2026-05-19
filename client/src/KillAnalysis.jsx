import { useState, useMemo, useRef } from 'react';

const CPL_TARGET = 300;
const CPL_HARD_KILL = 600;
const CPL_SOFT_KILL = 450;
const UNIVERSAL_CPULC_S1 = 10;
const UNIVERSAL_CPULC_S2 = 7;
const UNIVERSAL_CPM = 150;

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
  };
}

function computeBaselines(rows) {
  const byCamp = {};
  for (const r of rows) {
    const c = r.campaign;
    if (!byCamp[c]) byCamp[c] = { spend: 0, uclicks: 0, impressions: 0, results: 0, count: 0 };
    byCamp[c].spend += r.spend;
    byCamp[c].uclicks += r.uclicks;
    byCamp[c].impressions += r.impressions;
    byCamp[c].results += r.results;
    byCamp[c].count++;
  }
  const baselines = {};
  for (const [c, d] of Object.entries(byCamp)) {
    const cpulc = d.uclicks > 0 ? d.spend / d.uclicks : null;
    const cpm = d.impressions > 0 ? (d.spend / d.impressions) * 1000 : null;
    const cpl = d.results > 0 ? d.spend / d.results : null;
    baselines[c] = {
      cpulc, cpm, cpl,
      totalSpend: d.spend,
      totalLeads: d.results,
      adsetCount: d.count,
      // Derived kill thresholds for this campaign
      thresholdS1: cpulc ? Math.min(UNIVERSAL_CPULC_S1, cpulc * 4) : UNIVERSAL_CPULC_S1,
      thresholdS2: cpulc ? Math.min(UNIVERSAL_CPULC_S2, cpulc * 3) : UNIVERSAL_CPULC_S2,
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

  if (r.cpl != null && r.cpl <= CPL_TARGET) {
    return { stage, flag: 'safe', reasons: [`CPL $${r.cpl.toFixed(0)} ≤ $${CPL_TARGET} target`] };
  }
  if (r.results >= 3 && r.cpl != null && r.cpl <= CPL_SOFT_KILL) {
    return { stage, flag: 'safe', reasons: [`${r.results} leads at CPL $${r.cpl.toFixed(0)}`] };
  }

  const hard = [];
  const soft = [];
  if (r.spend >= 50 && r.linkClicks === 0) hard.push('0 link clicks at $50+');
  if (r.cpm != null && r.cpm >= UNIVERSAL_CPM) hard.push(`CPM $${r.cpm.toFixed(0)} ≥ $${UNIVERSAL_CPM}`);

  if (stage === 'S1' && r.spend >= 50) {
    const t = baseline?.thresholdS1 ?? UNIVERSAL_CPULC_S1;
    if (r.cpulc != null && r.cpulc >= t) hard.push(`CPULC $${r.cpulc.toFixed(2)} ≥ $${t.toFixed(2)}`);
    if (r.cpulc != null && r.cpulc >= 7 && r.cpm != null && r.cpm >= 60) hard.push(`Combo: CPULC ≥$7 + CPM ≥$60`);
  }
  if (stage === 'S2' || stage === 'S3' || stage === 'mature') {
    const t = baseline?.thresholdS2 ?? UNIVERSAL_CPULC_S2;
    if (r.cpulc != null && r.cpulc >= t) hard.push(`CPULC $${r.cpulc.toFixed(2)} ≥ $${t.toFixed(2)}`);
    if (r.cpulc != null && r.cpulc >= 5 && r.cpm != null && r.cpm >= 60) hard.push(`Combo: CPULC ≥$5 + CPM ≥$60`);
    if (r.uctr != null && r.uctr <= 0.4 && r.cpulc != null && r.cpulc >= 5) hard.push(`UCTR ${r.uctr.toFixed(2)}% + CPULC ≥$5`);
    if (r.spend >= 150 && r.lpv === 0 && r.linkClicks > 0) hard.push(`0 LPVs at $150+`);
  }
  if (r.spend >= 300 && r.results === 0) hard.push(`$300+ spent, 0 leads`);
  if (r.cpl != null && r.cpl >= CPL_HARD_KILL) hard.push(`CPL $${r.cpl.toFixed(0)} ≥ $${CPL_HARD_KILL}`);
  if (r.cpl != null && r.cpl >= CPL_SOFT_KILL && r.cpl < CPL_HARD_KILL) soft.push(`CPL $${r.cpl.toFixed(0)} ≥ $${CPL_SOFT_KILL}`);

  if (hard.length) { flag = 'hard'; reasons.push(...hard); }
  else if (soft.length) { flag = 'soft'; reasons.push(...soft); }
  else if (stage === 'pre') { flag = 'pre'; }
  else { flag = 'watch'; }

  return { stage, flag, reasons };
}

const FLAG_COLORS = {
  hard:  { bg: 'rgba(220,38,38,0.10)', border: '#dc2626', label: 'KILL', text: '#991b1b' },
  soft:  { bg: 'rgba(245,158,11,0.10)', border: '#f59e0b', label: 'SOFT', text: '#92400e' },
  watch: { bg: 'transparent', border: 'transparent', label: '', text: 'var(--text)' },
  safe:  { bg: 'rgba(34,197,94,0.08)', border: '#16a34a', label: 'SAFE', text: '#15803d' },
  pre:   { bg: 'transparent', border: 'transparent', label: 'NEW', text: 'var(--text-muted)' },
};

function fmt$(v) { return v == null ? '—' : `$${v.toFixed(v < 10 ? 2 : 0)}`; }
function fmtPct(v) { return v == null ? '—' : `${v.toFixed(2)}%`; }
function fmtNum(v) { return v == null ? '—' : v.toFixed(0); }

export default function KillAnalysis() {
  const [rows, setRows] = useState([]);
  const [fileName, setFileName] = useState('');
  const [expanded, setExpanded] = useState({});
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('spend');
  const [sortDir, setSortDir] = useState('desc');
  const [filterFlag, setFilterFlag] = useState('all');
  const [filterDelivery, setFilterDelivery] = useState('all');
  const fileRef = useRef(null);

  function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    Promise.all(files.map(f => f.text())).then(texts => {
      const all = texts.flatMap(parseCsv).map(mapRow).filter(r => r.spend > 0 && r.name);
      setRows(all);
      setFileName(files.map(f => f.name).join(', '));
      setExpanded({});
    });
  }

  const baselines = useMemo(() => computeBaselines(rows), [rows]);

  const enriched = useMemo(() => rows.map(r => {
    const base = baselines[r.campaign];
    const evalRes = evaluateKill(r, base);
    const quad = quadrant(r.cpm, r.cpulc);
    return { ...r, baseline: base, ...evalRes, quad };
  }), [rows, baselines]);

  // Group by campaign
  const campaignGroups = useMemo(() => {
    const groups = {};
    for (const r of enriched) {
      if (!groups[r.campaign]) {
        groups[r.campaign] = {
          name: r.campaign,
          baseline: baselines[r.campaign],
          rows: [],
          counts: { hard: 0, soft: 0, watch: 0, safe: 0, pre: 0 },
          hardSpend: 0,
        };
      }
      groups[r.campaign].rows.push(r);
      groups[r.campaign].counts[r.flag] = (groups[r.campaign].counts[r.flag] || 0) + 1;
      if (r.flag === 'hard') groups[r.campaign].hardSpend += r.spend;
    }
    // sort each group's rows by sortKey
    for (const g of Object.values(groups)) {
      g.rows.sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'string') return sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortDir === 'asc' ? av - bv : bv - av;
      });
    }
    // sort groups by total spend descending
    return Object.values(groups).sort((a, b) => b.baseline.totalSpend - a.baseline.totalSpend);
  }, [enriched, baselines, sortKey, sortDir]);

  // Apply top-level filters to the groups (filter rows within each)
  const visibleGroups = useMemo(() => {
    return campaignGroups.map(g => {
      let rs = g.rows;
      if (filterFlag !== 'all') rs = rs.filter(r => r.flag === filterFlag);
      if (filterDelivery !== 'all') rs = rs.filter(r => (r.delivery || '').toLowerCase() === filterDelivery);
      if (search) {
        const s = search.toLowerCase();
        rs = rs.filter(r => r.name.toLowerCase().includes(s));
      }
      return { ...g, visibleRows: rs };
    }).filter(g => search ? g.visibleRows.length > 0 : true);
  }, [campaignGroups, filterFlag, filterDelivery, search]);

  function clickSort(k) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir(k === 'name' ? 'asc' : 'desc'); }
  }

  function toggle(name) { setExpanded(e => ({ ...e, [name]: !e[name] })); }
  function expandAll() { setExpanded(Object.fromEntries(visibleGroups.map(g => [g.name, true]))); }
  function collapseAll() { setExpanded({}); }

  const grandHard = visibleGroups.reduce((s, g) => s + g.counts.hard, 0);
  const grandHardSpend = visibleGroups.reduce((s, g) => s + g.hardSpend, 0);
  const grandSoft = visibleGroups.reduce((s, g) => s + g.counts.soft, 0);
  const grandSafe = visibleGroups.reduce((s, g) => s + g.counts.safe, 0);

  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Kill Analysis</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Per-campaign kill thresholds · weekly CSV review</div>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input ref={fileRef} type="file" accept=".csv" multiple onChange={handleFiles} style={{ display: 'none' }} />
          <button className="btn btn--sm btn--primary" onClick={() => fileRef.current?.click()}>
            Upload CSV{rows.length ? 's (replace)' : ''}
          </button>
          {fileName && <span style={{ fontSize: 11, color: 'var(--text-muted)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fileName}</span>}
        </div>
      </div>

      {rows.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Upload one or more Facebook ad set CSV exports to begin.<br />
          <span style={{ fontSize: 11 }}>Each campaign gets its own kill thresholds based on its weighted CPULC/CPM/CPL.</span>
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Top filter strip */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill label="Hard kill" count={grandHard} sub={`$${grandHardSpend.toFixed(0)} wasted`} color="#dc2626" active={filterFlag==='hard'} onClick={() => setFilterFlag(filterFlag==='hard'?'all':'hard')} />
            <Pill label="Soft"      count={grandSoft} color="#f59e0b" active={filterFlag==='soft'} onClick={() => setFilterFlag(filterFlag==='soft'?'all':'soft')} />
            <Pill label="Safe"      count={grandSafe} color="#16a34a" active={filterFlag==='safe'} onClick={() => setFilterFlag(filterFlag==='safe'?'all':'safe')} />

            <div style={{ marginLeft: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={filterDelivery} onChange={e => setFilterDelivery(e.target.value)} style={selectStyle}>
                <option value="all">All delivery</option>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
              </select>
              <input
                type="text"
                placeholder="Search ad set…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                style={{ ...selectStyle, minWidth: 200 }}
              />
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 11 }}>
              <button onClick={expandAll}  style={btnSm}>Expand all</button>
              <button onClick={collapseAll} style={btnSm}>Collapse all</button>
            </div>
          </div>

          {/* Campaign cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visibleGroups.map(g => (
              <CampaignCard
                key={g.name}
                group={g}
                isOpen={!!expanded[g.name]}
                onToggle={() => toggle(g.name)}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={clickSort}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CampaignCard({ group, isOpen, onToggle, sortKey, sortDir, onSort }) {
  const b = group.baseline;
  const { counts, hardSpend, visibleRows } = group;

  // Severity-based border
  const cardBorderColor = counts.hard > 0 ? '#dc2626' : counts.soft > 0 ? '#f59e0b' : 'var(--border)';

  // Kill thresholds derived for this campaign
  const cplOverTarget = b.cpl != null && b.cpl > CPL_TARGET;

  return (
    <div style={{
      border: `1px solid ${cardBorderColor}`,
      borderLeft: `4px solid ${cardBorderColor}`,
      borderRadius: 10, background: 'var(--surface)', overflow: 'hidden',
    }}>
      {/* HEADER — always visible. THIS is the main focus. */}
      <div
        onClick={onToggle}
        style={{ padding: '14px 16px', cursor: 'pointer', userSelect: 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
          {/* Name + arrow */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 220 }}>
            <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>{isOpen ? '▼' : '▶'}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{group.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {b.adsetCount} adsets · ${b.totalSpend.toFixed(0)} spent · {b.totalLeads} leads
              </div>
            </div>
          </div>

          {/* Counts strip */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {counts.hard  > 0 && <CountBadge n={counts.hard} label="KILL"  color="#dc2626" sub={`$${hardSpend.toFixed(0)}`} />}
            {counts.soft  > 0 && <CountBadge n={counts.soft} label="SOFT" color="#f59e0b" />}
            {counts.safe  > 0 && <CountBadge n={counts.safe} label="SAFE" color="#16a34a" />}
            {counts.watch > 0 && <CountBadge n={counts.watch} label="WATCH" color="var(--text-muted)" />}
            {counts.pre   > 0 && <CountBadge n={counts.pre}   label="NEW"  color="var(--text-muted)" />}
          </div>

          {/* MAIN FOCUS: kill threshold stats */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <StatBlock label="Baseline CPULC" value={fmt$(b.cpulc)} sub="weighted" />
            <StatBlock label="Baseline CPM"   value={fmt$(b.cpm)}   sub="weighted" />
            <StatBlock label="Baseline CPL"   value={fmt$(b.cpl)}   sub={cplOverTarget ? `> $${CPL_TARGET} target` : 'weighted'} valueColor={cplOverTarget ? '#dc2626' : null} />

            <div style={{ width: 1, height: 36, background: 'var(--border)' }} />

            <StatBlock label="$50+ kill"  value={fmt$(b.thresholdS1)} sub="CPULC ≥" critical />
            <StatBlock label="$150+ kill" value={fmt$(b.thresholdS2)} sub="CPULC ≥" critical />
            <StatBlock label="$300+ kill" value={`$${CPL_HARD_KILL}`} sub="CPL ≥ / 0 leads" critical />
          </div>
        </div>
      </div>

      {/* ADSET TABLE — collapsible */}
      {isOpen && (
        <div style={{ borderTop: '1px solid var(--border)', overflow: 'auto', maxHeight: '70vh' }}>
          {visibleRows.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              No adsets match the current filters.
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr>
                  <th style={thL}>Flag</th>
                  <SortableTh keyName="name" label="Ad set" align="left" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="spend" label="Spend" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th style={th}>Stage</th>
                  <th style={th}>Quad</th>
                  <SortableTh keyName="cpulc" label="CPULC" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th style={th}>× base</th>
                  <SortableTh keyName="cpm" label="CPM" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="uctr" label="U-CTR" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="freq" label="Freq" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="results" label="Leads" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="cpl" label="CPL" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <th style={thL}>Reasons</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => {
                  const color = FLAG_COLORS[r.flag] || FLAG_COLORS.watch;
                  const cpulcMul = b?.cpulc && r.cpulc ? r.cpulc / b.cpulc : null;
                  const cplOver = r.cpl != null && r.cpl > CPL_TARGET;
                  return (
                    <tr key={i} style={{ background: color.bg, borderLeft: `3px solid ${color.border}` }}>
                      <td style={tdL}>
                        {color.label && <span style={{ background: color.border, color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{color.label}</span>}
                      </td>
                      <td style={{ ...tdL, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</td>
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
                      <td style={{ ...td, color: cplOver ? '#dc2626' : 'var(--text)', fontWeight: cplOver ? 600 : 400 }}>
                        {fmt$(r.cpl)}
                      </td>
                      <td style={{ ...tdL, fontSize: 11, color: color.text, maxWidth: 360, whiteSpace: 'normal' }}>
                        {(r.reasons || []).join(' · ')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

function StatBlock({ label, value, sub, critical, valueColor }) {
  return (
    <div style={{
      minWidth: 95,
      padding: '6px 12px',
      background: critical ? 'rgba(220,38,38,0.06)' : 'transparent',
      border: critical ? '1px solid rgba(220,38,38,0.25)' : '1px solid transparent',
      borderRadius: 6,
    }}>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: critical ? '#dc2626' : 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: valueColor || (critical ? '#dc2626' : 'var(--text)'), lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function CountBadge({ n, label, color, sub }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      background: color === 'var(--text-muted)' ? 'var(--bg)' : `${color}22`,
      border: `1px solid ${color === 'var(--text-muted)' ? 'var(--border)' : color}`,
      borderRadius: 6, padding: '4px 10px', minWidth: 50,
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: color === 'var(--text-muted)' ? 'var(--text)' : color, lineHeight: 1 }}>{n}</div>
      <div style={{ fontSize: 9, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function SortableTh({ keyName, label, align = 'right', sortKey, sortDir, onSort }) {
  const isActive = sortKey === keyName;
  return (
    <th style={align === 'left' ? thL : th} onClick={() => onSort(keyName)}>
      {label}
      {isActive && <span style={{ marginLeft: 4, color: 'var(--text)' }}>{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </th>
  );
}

const th = { padding: '8px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)', borderBottom: '2px solid var(--border)', background: 'var(--surface)', textAlign: 'right', cursor: 'pointer', whiteSpace: 'nowrap', position: 'sticky', top: 0, zIndex: 2 };
const thL = { ...th, textAlign: 'left' };
const td = { padding: '6px 10px', fontSize: 12, textAlign: 'right', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
const tdL = { ...td, textAlign: 'left' };

const selectStyle = {
  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', padding: '5px 8px', fontSize: 12, outline: 'none',
};
const btnSm = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5,
  padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: 'var(--text-muted)',
};

function Pill({ label, count, sub, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
        background: active ? color : 'var(--surface)',
        border: `1px solid ${color === 'var(--text-muted)' ? 'var(--border)' : color}`,
        borderRadius: 8, padding: '6px 12px', cursor: 'pointer',
        color: active ? '#fff' : 'var(--text)', minWidth: 95,
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.85 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}>{count}</div>
      {sub && <div style={{ fontSize: 10, opacity: 0.75 }}>{sub}</div>}
    </button>
  );
}
