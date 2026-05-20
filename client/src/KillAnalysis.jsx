import { useState, useMemo, useRef, useEffect, Component } from 'react';
import { dbGetAll, dbUpsert, dbDelete, dbClearStore } from './db.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Server-side snapshot store — shared across devices
const serverApi = {
  async list() {
    const r = await fetch(`${BASE}/api/snapshots`);
    if (!r.ok) throw new Error(`list failed: ${r.status}`);
    const d = await r.json();
    return d.snapshots || [];
  },
  async save(snapshots) {
    const r = await fetch(`${BASE}/api/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshots }),
    });
    if (!r.ok) throw new Error(`save failed: ${r.status}`);
    return r.json();
  },
  async delete(id) {
    const r = await fetch(`${BASE}/api/snapshots/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`delete failed: ${r.status}`);
    return r.json();
  },
  async clear() {
    const r = await fetch(`${BASE}/api/snapshots`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`clear failed: ${r.status}`);
    return r.json();
  },
};

class KillErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('Kill Analysis crash:', err, info); }
  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24 }}>
          <h3 style={{ color: '#dc2626', marginTop: 0 }}>Kill Analysis crashed</h3>
          <pre style={{ background: 'rgba(220,38,38,0.08)', padding: 12, borderRadius: 6, fontSize: 12, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
            {String(this.state.err?.stack || this.state.err)}
          </pre>
          <button onClick={() => this.setState({ err: null })} style={{ marginTop: 12, padding: '6px 12px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
            Try again
          </button>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12 }}>
            If this keeps happening, open the Snapshots panel and try "Clear all" to wipe corrupt saved data.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

const CPL_TARGET = 300;                 // universal target ceiling — no-leads kill caps here
const NO_LEADS_HARD_MULT = 1.25;        // no-leads kill at 1.25× baseline (small buffer for lead-arrival lumpiness)
const NO_LEADS_SOFT_RATIO = 0.67;       // soft warning when 2/3 of the way to no-leads kill
const NO_LEADS_SOFT_CAP = 200;          // ceiling on no-leads soft warning
const CPL_HARD_MULT = 2;                // once leads exist, hard kill at 2× baseline
const CPL_SOFT_MULT = 1.5;              // once leads exist, soft kill at 1.5× baseline
const CPL_HARD_CAP = 600;               // ceiling on with-leads hard kill
const CPL_SOFT_CAP = 450;               // ceiling on with-leads soft kill
const UNIVERSAL_CPULC_S1 = 10;
const UNIVERSAL_CPULC_S2 = 7;
const OUTBOUND_CTR_RATIO = 0.6;         // outbound ÷ link CTR below this = clicks not actually leaving FB (curiosity/fake)
const MIN_CPULC_RATIO = 0.25;           // suspicious bait traffic threshold = 25% of campaign baseline CPULC
const MIN_CPULC_FLOOR = 0.30;           // floor — never kill above zero unless CPULC is below this absolute minimum
const MIN_CPULC_CAP = 1.50;             // ceiling — even for very expensive baselines, don't claim bait above this
const UNIVERSAL_CPULC_MIN_FALLBACK = 0.50; // fallback when baseline is unknown (no clicks yet)
const UNIVERSAL_CPM = 150;

function parseFloatSafe(s) {
  if (s == null || s === '') return null;
  const v = parseFloat(String(s).replace(/[%,$]/g, '').trim());
  return Number.isFinite(v) ? v : null;
}

// Extract ad account name from a CSV filename like "Zemsky-&-Salomon-P.C.-Ad-sets-May-7-2026-May-12-2026.csv"
function extractAccount(filename) {
  const base = (filename || '').replace(/\.csv$/i, '');
  const m = base.match(/^(.+?)[-\s]+Ad[-\s]?sets?[-\s]/i);
  if (m) return m[1].replace(/[-\s]+$/, '').trim();
  return base;
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
    reportStart: r['Reporting starts'] || '',
    reportEnd: r['Reporting ends'] || '',
    spend,
    results: parseFloatSafe(r['Results']) || 0,
    cpl: parseFloatSafe(r['Cost per results']),
    uclicks,
    linkClicks,
    cpulc: parseFloatSafe(r['Cost per unique link click (USD)']),
    cpm,
    impressions,
    uctr: parseFloatSafe(r['Unique CTR (link click-through rate)']),
    outboundCtr: parseFloatSafe(r['Unique outbound CTR (click-through rate)']),
    reach: parseFloatSafe(r['Reach']) || 0,
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
      totalSpend: d.spend, totalLeads: d.results, adsetCount: d.count,
      thresholdS1: cpulc ? Math.min(UNIVERSAL_CPULC_S1, cpulc * 4) : UNIVERSAL_CPULC_S1,
      thresholdS2: cpulc ? Math.min(UNIVERSAL_CPULC_S2, cpulc * 3) : UNIVERSAL_CPULC_S2,
      // Min CPULC = 25% of campaign baseline, floored at $0.30, capped at $1.50
      minCpulc: cpulc
        ? Math.min(Math.max(cpulc * MIN_CPULC_RATIO, MIN_CPULC_FLOOR), MIN_CPULC_CAP)
        : UNIVERSAL_CPULC_MIN_FALLBACK,
      // No-leads kill: 1.25× baseline CPL with 0 leads, capped at $300
      noLeadsHardKill: cpl ? Math.min(cpl * NO_LEADS_HARD_MULT, CPL_TARGET) : CPL_TARGET,
      noLeadsSoftKill: cpl
        ? Math.min(cpl * NO_LEADS_HARD_MULT * NO_LEADS_SOFT_RATIO, NO_LEADS_SOFT_CAP)
        : NO_LEADS_SOFT_CAP,
      // With-leads CPL kill thresholds — used only when an ad has ≥1 lead
      cplHardKill: cpl ? Math.min(cpl * CPL_HARD_MULT, CPL_HARD_CAP) : CPL_HARD_CAP,
      cplSoftKill: cpl ? Math.min(cpl * CPL_SOFT_MULT, CPL_SOFT_CAP) : CPL_SOFT_CAP,
    };
  }
  return baselines;
}

function stageOf(spend) {
  if (spend < 50) return 'pre';
  if (spend < 150) return 'S1';
  if (spend < 200) return 'S2';
  if (spend < 300) return 'S3';
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

function evaluateKill(r, baseline, prior) {
  const stage = stageOf(r.spend);
  const hard = [];
  const soft = [];

  // Layer 4 — Safe override: ad is doing AT LEAST as well as the campaign baseline.
  // Once leads exist we compare to baseline; falls back to universal $300 when baseline unknown.
  const baselineCpl = baseline?.cpl;
  if (r.results >= 1 && r.cpl != null) {
    const safeLine = baselineCpl ?? CPL_TARGET;
    if (r.cpl <= safeLine) {
      return { stage, flag: 'safe', reasons: [`CPL $${r.cpl.toFixed(0)} ≤ baseline $${safeLine.toFixed(0)}`], fatigue: null };
    }
  }

  // Universal hard kills
  if (r.spend >= 50 && r.linkClicks === 0) hard.push('0 link clicks at $50+');
  if (r.cpm != null && r.cpm >= UNIVERSAL_CPM) hard.push(`CPM $${r.cpm.toFixed(0)} ≥ $${UNIVERSAL_CPM}`);

  // CPULC stage rules
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

  // Outbound CTR gap — clicks aren't actually leaving FB to the landing page
  if (r.spend >= 100 && r.uctr != null && r.uctr > 0 && r.outboundCtr != null) {
    const ratio = r.outboundCtr / r.uctr;
    if (ratio <= OUTBOUND_CTR_RATIO) {
      soft.push(`Outbound CTR ${r.outboundCtr.toFixed(2)}% / link CTR ${r.uctr.toFixed(2)}% = ${(ratio*100).toFixed(0)}% (clicks not leaving FB)`);
    }
  }

  // Minimum CPULC — clicks too cheap to be real (bait / bot traffic). Per-campaign baseline-relative.
  const minCpulcLine = baseline?.minCpulc ?? UNIVERSAL_CPULC_MIN_FALLBACK;
  if (r.spend >= 50 && r.cpulc != null && r.cpulc < minCpulcLine) {
    const baseStr = baseline?.cpulc ? ` (< 25% of $${baseline.cpulc.toFixed(2)} baseline)` : '';
    hard.push(`CPULC $${r.cpulc.toFixed(2)} < $${minCpulcLine.toFixed(2)} min${baseStr} (bait traffic)`);
  }

  // No-lead spend rules — kill at baseline CPL (capped at $300 universal target)
  if (r.results === 0) {
    const hardLine = baseline?.noLeadsHardKill ?? CPL_TARGET;
    const softLine = baseline?.noLeadsSoftKill ?? NO_LEADS_SOFT_CAP;
    if (r.spend >= hardLine) {
      const baseStr = baseline?.cpl && baseline.cpl * NO_LEADS_HARD_MULT < CPL_TARGET
        ? ` (${NO_LEADS_HARD_MULT}× $${baseline.cpl.toFixed(0)} baseline)`
        : ` ($${CPL_TARGET} cap)`;
      hard.push(`$${hardLine.toFixed(0)} spent, 0 leads${baseStr}`);
    } else if (r.spend >= softLine) {
      soft.push(`$${softLine.toFixed(0)}+ spent, 0 leads (approaching kill line)`);
    }
  }

  // CPL rules ONLY apply when ad has ≥1 lead — relative to campaign baseline with cap
  if (r.results >= 1 && r.cpl != null) {
    const hardLine = baseline?.cplHardKill ?? CPL_HARD_CAP;
    const softLine = baseline?.cplSoftKill ?? CPL_SOFT_CAP;
    if (r.cpl >= hardLine) {
      const baseStr = baselineCpl ? ` (≥${CPL_HARD_MULT}× $${baselineCpl.toFixed(0)} baseline)` : '';
      hard.push(`CPL $${r.cpl.toFixed(0)} ≥ $${hardLine.toFixed(0)}${baseStr}`);
    }
  }

  // Fatigue detection vs prior snapshot
  let fatigue = null;
  if (prior) {
    const cplDelta = (prior.cpl && r.cpl) ? (r.cpl - prior.cpl) / prior.cpl : null;
    const cpulcDelta = (prior.cpulc && r.cpulc) ? (r.cpulc - prior.cpulc) / prior.cpulc : null;
    const leadsDelta = prior.results >= 3 ? (r.results - prior.results) / prior.results : null;
    const uctrDelta = (prior.uctr && r.uctr) ? (r.uctr - prior.uctr) / prior.uctr : null;
    fatigue = { cplDelta, cpulcDelta, leadsDelta, uctrDelta, prior };
    if (cplDelta != null && cplDelta >= 1.0) hard.push(`CPL up ${(cplDelta*100).toFixed(0)}% vs prior`);
    else if (cplDelta != null && cplDelta >= 0.5) soft.push(`CPL up ${(cplDelta*100).toFixed(0)}% vs prior`);
    if (leadsDelta != null && leadsDelta <= -0.75 && prior.results >= 3) hard.push(`Leads dropped ${Math.abs(leadsDelta*100).toFixed(0)}% (prior had ${prior.results})`);
    if (cpulcDelta != null && cpulcDelta >= 0.5 && uctrDelta != null && uctrDelta < 0) soft.push(`CPULC up + UCTR down vs prior`);
  }

  let flag;
  if (hard.length) flag = 'hard';
  else if (soft.length) flag = 'soft';
  else if (stage === 'pre') flag = 'pre';
  else flag = 'watch';

  return { stage, flag, reasons: hard.concat(soft), fatigue };
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
function fmtDelta(v) {
  if (v == null) return null;
  const pct = (v * 100).toFixed(0);
  const sign = v > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

export default function KillAnalysis() {
  return <KillErrorBoundary><KillAnalysisInner /></KillErrorBoundary>;
}

function KillAnalysisInner() {
  const [snapshots, setSnapshots] = useState([]);  // [{ id, account, label, dateStart, dateEnd, uploadedAt, rows }]
  const [expanded, setExpanded] = useState({});
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('spend');
  const [sortDir, setSortDir] = useState('desc');
  const [filterFlag, setFilterFlag] = useState('all');
  const [filterDelivery, setFilterDelivery] = useState('active');
  const [snapMgrOpen, setSnapMgrOpen] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [serverStatus, setServerStatus] = useState('unknown'); // 'unknown' | 'ok' | 'offline'
  const fileRef = useRef(null);

  // Load snapshots — server is source of truth; auto-sync any local-only snapshots up.
  useEffect(() => {
    async function load() {
      let serverList = [];
      try {
        serverList = await serverApi.list();
        setServerStatus('ok');
      } catch (err) {
        setServerStatus('offline');
        // Server unreachable — fall back to IndexedDB only
        try {
          const local = await dbGetAll('killSnapshots');
          const normalized = (local || []).map(s => s.account ? s : { ...s, account: extractAccount(s.label) });
          const sorted = normalized.sort((a, b) => (b.dateEnd || '').localeCompare(a.dateEnd || ''));
          setSnapshots(sorted);
          if (sorted.length) setError(`Server unreachable. Showing local cache only (${sorted.length} snapshot${sorted.length === 1 ? '' : 's'}). Other devices won't see this data.`);
        } catch (e2) {
          setError(`Couldn't load snapshots: ${err?.message || err}`);
        }
        return;
      }

      // Server reachable. Read local cache to find any snapshots not yet on the server.
      let local = [];
      try { local = await dbGetAll('killSnapshots'); } catch {}
      const serverIds = new Set(serverList.map(s => s.id));
      const localOnly = (local || []).filter(s => !serverIds.has(s.id));

      // Auto-push local-only snapshots to the server so they sync across devices.
      if (localOnly.length) {
        try {
          await serverApi.save(localOnly);
          serverList = serverList.concat(localOnly);
          setError(`Synced ${localOnly.length} local snapshot${localOnly.length === 1 ? '' : 's'} up to the server.`);
        } catch (err) {
          // Save failed, but still show what's on server
          setError(`Local snapshots exist that didn't sync up: ${err?.message || err}`);
        }
      }

      const normalized = serverList.map(s => s.account ? s : { ...s, account: extractAccount(s.label) });
      const sorted = normalized.sort((a, b) => (b.dateEnd || '').localeCompare(a.dateEnd || ''));
      setSnapshots(sorted);
      if (sorted.length) dbUpsert('killSnapshots', sorted).catch(() => {});
    }
    load();
  }, []);

  async function handleFiles(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setError(null);
    setLoading(true);
    try {
      // Step 1: read all files in parallel — this is fast
      const texts = await Promise.all(files.map(f => f.text().then(t => ({ name: f.name, text: t }))));

      // Step 2: parse synchronously — also fast
      const newSnaps = [];
      const parseErrors = [];
      for (const { name, text } of texts) {
        try {
          const parsed = parseCsv(text).map(mapRow).filter(r => r.spend > 0 && r.name);
          if (!parsed.length) {
            parseErrors.push(`${name}: no rows with spend > 0`);
            continue;
          }
          const dateStart = parsed[0]?.reportStart || '';
          const dateEnd = parsed[0]?.reportEnd || '';
          const account = extractAccount(name);
          const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          newSnaps.push({ id, account, label: name, dateStart, dateEnd, uploadedAt: new Date().toISOString(), rows: parsed });
        } catch (e) {
          parseErrors.push(`${name}: ${e.message}`);
        }
      }
      if (parseErrors.length) setError(parseErrors.join(' · '));
      if (!newSnaps.length) return;

      // Step 3: update React state IMMEDIATELY so user sees data
      const all = [...snapshots, ...newSnaps].sort((a, b) => (b.dateEnd || '').localeCompare(a.dateEnd || ''));
      setSnapshots(all);

      // Step 4: persist to server (source of truth) + local cache, both in background
      serverApi.save(newSnaps).catch(err => {
        setError(`Saved locally only — server save failed: ${err?.message || err}. Other devices won't see these snapshots.`);
      });
      dbUpsert('killSnapshots', newSnaps).catch(() => {});
    } catch (e) {
      setError(`Upload failed: ${e?.message || e}`);
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function deleteSnapshot(id) {
    if (!confirm('Delete this snapshot permanently?')) return;
    setSnapshots(snapshots.filter(s => s.id !== id));
    serverApi.delete(id).catch(err => setError(`Server delete failed: ${err?.message || err}`));
    dbDelete('killSnapshots', id).catch(() => {});
  }

  async function clearAllSnapshots() {
    if (!confirm('Delete ALL saved snapshots? This cannot be undone.')) return;
    setSnapshots([]);
    serverApi.clear().catch(err => setError(`Server clear failed: ${err?.message || err}`));
    dbClearStore('killSnapshots').catch(() => {});
  }

  // Auto-group snapshots by ad account, pick newest as current, second-newest as compare
  const accountPairs = useMemo(() => {
    const byAcc = {};
    for (const s of snapshots) {
      const a = s.account || extractAccount(s.label);
      if (!byAcc[a]) byAcc[a] = [];
      byAcc[a].push(s);
    }
    return Object.entries(byAcc).map(([account, list]) => {
      const sorted = list.slice().sort((a, b) => (b.dateEnd || '').localeCompare(a.dateEnd || ''));
      return { account, current: sorted[0] || null, compare: sorted[1] || null, all: sorted };
    }).sort((a, b) => a.account.localeCompare(b.account));
  }, [snapshots]);

  // Current view = all "current" snapshots merged
  const currentRows = useMemo(() => {
    return accountPairs.flatMap(p => p.current ? p.current.rows.map(r => ({ ...r, _account: p.account })) : []);
  }, [accountPairs]);

  // Per-account prior lookup, keyed by "account|adset name" to prevent cross-account name collisions
  const priorByAdset = useMemo(() => {
    const map = {};
    for (const p of accountPairs) {
      if (!p.compare) continue;
      for (const r of p.compare.rows) {
        map[`${p.account}|${r.name}`] = r;
      }
    }
    return map;
  }, [accountPairs]);

  const hasAnyCompare = accountPairs.some(p => p.compare);

  // Baselines: ALL ads with spend (active + inactive) for accurate campaign norms
  const baselines = useMemo(() => computeBaselines(currentRows), [currentRows]);

  // Rated set: filter by delivery (default active)
  const ratedRows = useMemo(() => {
    if (filterDelivery === 'all') return currentRows;
    return currentRows.filter(r => (r.delivery || '').toLowerCase() === filterDelivery);
  }, [currentRows, filterDelivery]);

  const enriched = useMemo(() => ratedRows.map(r => {
    const base = baselines[r.campaign];
    const prior = priorByAdset[`${r._account}|${r.name}`];
    const ev = evaluateKill(r, base, prior);
    const quad = quadrant(r.cpm, r.cpulc);
    return { ...r, baseline: base, ...ev, quad };
  }), [ratedRows, baselines, priorByAdset]);

  const campaignGroups = useMemo(() => {
    const groups = {};
    for (const r of enriched) {
      if (!groups[r.campaign]) {
        groups[r.campaign] = {
          name: r.campaign, baseline: baselines[r.campaign], rows: [],
          counts: { hard: 0, soft: 0, watch: 0, safe: 0, pre: 0 },
          hardSpend: 0, ratedSpend: 0, ratedLeads: 0,
        };
      }
      groups[r.campaign].rows.push(r);
      groups[r.campaign].counts[r.flag] = (groups[r.campaign].counts[r.flag] || 0) + 1;
      if (r.flag === 'hard') groups[r.campaign].hardSpend += r.spend;
      groups[r.campaign].ratedSpend += r.spend;
      groups[r.campaign].ratedLeads += r.results;
    }
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
    return Object.values(groups).sort((a, b) => b.baseline.totalSpend - a.baseline.totalSpend);
  }, [enriched, baselines, sortKey, sortDir]);

  const visibleGroups = useMemo(() => {
    return campaignGroups.map(g => {
      let rs = g.rows;
      if (filterFlag !== 'all') rs = rs.filter(r => r.flag === filterFlag);
      if (search) {
        const s = search.toLowerCase();
        rs = rs.filter(r => r.name.toLowerCase().includes(s));
      }
      return { ...g, visibleRows: rs };
    }).filter(g => search ? g.visibleRows.length > 0 : true);
  }, [campaignGroups, filterFlag, search]);

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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Kill Analysis</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>CPL target ${CPL_TARGET} · saved snapshots for fatigue tracking</div>

        <span style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700,
          background: serverStatus === 'ok' ? 'rgba(34,197,94,0.15)' : serverStatus === 'offline' ? 'rgba(220,38,38,0.15)' : 'var(--bg)',
          color: serverStatus === 'ok' ? '#15803d' : serverStatus === 'offline' ? '#991b1b' : 'var(--text-muted)',
          border: `1px solid ${serverStatus === 'ok' ? '#16a34a' : serverStatus === 'offline' ? '#dc2626' : 'var(--border)'}`,
        }}>
          {serverStatus === 'ok' ? '● synced' : serverStatus === 'offline' ? '● local only' : '● checking…'}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={() => setSnapMgrOpen(o => !o)} style={btnSm}>
            {snapMgrOpen ? '▲' : '▼'} Snapshots ({snapshots.length})
          </button>
          <input ref={fileRef} type="file" accept=".csv" multiple onChange={handleFiles} style={{ display: 'none' }} />
          <button className="btn btn--sm btn--primary" onClick={() => fileRef.current?.click()} disabled={loading}>
            {loading ? 'Uploading…' : 'Upload CSV'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: 12, borderRadius: 6,
          background: 'rgba(220,38,38,0.08)', border: '1px solid #dc2626',
          color: '#991b1b', fontSize: 12, display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <span style={{ flex: 1 }}>{error}</span>
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#991b1b', cursor: 'pointer', fontSize: 16, padding: 0 }}>×</button>
        </div>
      )}

      {/* Account/snapshot manager */}
      {snapMgrOpen && (
        <div style={{ marginBottom: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>Ad accounts &amp; snapshots</strong>
            <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>
              Newest per account = current view · second-newest = fatigue compare
            </span>
            {snapshots.length > 0 && (
              <button onClick={clearAllSnapshots} style={{ marginLeft: 'auto', ...btnSm, color: '#dc2626', borderColor: '#dc2626' }}>Clear all</button>
            )}
          </div>
          {accountPairs.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' }}>No snapshots saved yet. Upload a CSV to get started.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {accountPairs.map(p => (
                <div key={p.account} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                    <strong style={{ fontSize: 12 }}>{p.account}</strong>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{p.all.length} snapshot{p.all.length === 1 ? '' : 's'}</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 130px 90px 70px', gap: '4px 10px', fontSize: 11, alignItems: 'center' }}>
                    {p.all.map(s => {
                      const role = s.id === p.current?.id ? 'CURRENT' : s.id === p.compare?.id ? 'COMPARE' : '';
                      const color = role === 'CURRENT' ? '#16a34a' : role === 'COMPARE' ? '#3b82f6' : 'var(--text-muted)';
                      return (
                        <div key={s.id} style={{ display: 'contents' }}>
                          <span style={{ background: role ? color : 'var(--bg)', color: role ? '#fff' : 'var(--text-muted)', padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, textAlign: 'center' }}>{role || '—'}</span>
                          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.label}>{s.label}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{s.dateStart} → {s.dateEnd}</span>
                          <span style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{s.rows.length} rows</span>
                          <button onClick={() => deleteSnapshot(s.id)} style={{ ...btnSm, color: '#dc2626', padding: '2px 8px' }}>Delete</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {currentRows.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
          Upload one or more Facebook ad set CSV exports to begin.<br />
          <span style={{ fontSize: 11 }}>Filename should look like "AccountName-Ad-sets-{`{date range}`}.csv". Newest per account is the live view; second-newest is the fatigue compare.</span>
        </div>
      )}

      {currentRows.length > 0 && (
        <>
          {/* Account status strip */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', fontSize: 11 }}>
            {accountPairs.map(p => (
              <div key={p.account} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }}>
                <strong style={{ fontSize: 12 }}>{p.account}</strong>
                <span style={{ color: 'var(--text-muted)' }}>
                  current: <strong style={{ color: '#16a34a' }}>{p.current?.dateStart}→{p.current?.dateEnd}</strong>
                  {p.compare && <> · compare: <strong style={{ color: '#3b82f6' }}>{p.compare.dateStart}→{p.compare.dateEnd}</strong></>}
                  {!p.compare && <> · <span style={{ color: '#f59e0b' }}>no fatigue compare (need 2+ snapshots)</span></>}
                </span>
              </div>
            ))}
          </div>

          {/* Filter strip */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill label="Hard kill" count={grandHard} sub={`$${grandHardSpend.toFixed(0)} wasted`} color="#dc2626" active={filterFlag==='hard'} onClick={() => setFilterFlag(filterFlag==='hard'?'all':'hard')} />
            <Pill label="Soft" count={grandSoft} color="#f59e0b" active={filterFlag==='soft'} onClick={() => setFilterFlag(filterFlag==='soft'?'all':'soft')} />
            <Pill label="Safe" count={grandSafe} color="#16a34a" active={filterFlag==='safe'} onClick={() => setFilterFlag(filterFlag==='safe'?'all':'safe')} />

            <div style={{ marginLeft: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={filterDelivery} onChange={e => setFilterDelivery(e.target.value)} style={selectStyle}>
                <option value="active">Active only</option>
                <option value="inactive">Inactive only</option>
                <option value="all">All delivery</option>
              </select>
              <input type="text" placeholder="Search ad set…" value={search} onChange={e => setSearch(e.target.value)} style={{ ...selectStyle, minWidth: 200 }} />
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 11 }}>
              <button onClick={expandAll}  style={btnSm}>Expand all</button>
              <button onClick={collapseAll} style={btnSm}>Collapse all</button>
            </div>
          </div>

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
                hasCompare={hasAnyCompare}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CampaignCard({ group, isOpen, onToggle, sortKey, sortDir, onSort, hasCompare }) {
  const b = group.baseline;
  const { counts, hardSpend, visibleRows } = group;
  const cardBorderColor = counts.hard > 0 ? '#dc2626' : counts.soft > 0 ? '#f59e0b' : 'var(--border)';

  return (
    <div style={{ border: `1px solid ${cardBorderColor}`, borderLeft: `4px solid ${cardBorderColor}`, borderRadius: 10, background: 'var(--surface)', overflow: 'hidden' }}>
      <div onClick={onToggle} style={{ padding: '14px 16px', cursor: 'pointer', userSelect: 'none' }}>
        {/* Row 1: name + counts + baselines */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 220 }}>
            <span style={{ fontSize: 14, color: 'var(--text-muted)' }}>{isOpen ? '▼' : '▶'}</span>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>{group.name}</div>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {group.rows.length} rated · ${group.ratedSpend.toFixed(0)} · {group.ratedLeads} leads
                <span style={{ marginLeft: 6, opacity: 0.7 }}>(baselines from {b.adsetCount} all · ${b.totalSpend.toFixed(0)})</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {counts.hard  > 0 && <CountBadge n={counts.hard} label="KILL"  color="#dc2626" sub={`$${hardSpend.toFixed(0)}`} />}
            {counts.soft  > 0 && <CountBadge n={counts.soft} label="SOFT" color="#f59e0b" />}
            {counts.safe  > 0 && <CountBadge n={counts.safe} label="SAFE" color="#16a34a" />}
            {counts.watch > 0 && <CountBadge n={counts.watch} label="WATCH" color="var(--text-muted)" />}
            {counts.pre   > 0 && <CountBadge n={counts.pre}   label="NEW"  color="var(--text-muted)" />}
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
            <MiniStat label="Baseline CPULC" value={fmt$(b.cpulc)} />
            <MiniStat label="Baseline CPM"   value={fmt$(b.cpm)} />
            <MiniStat label="Baseline CPL"   value={fmt$(b.cpl)} />
          </div>
        </div>

        {/* Row 2: kill thresholds grouped — click-quality stats left, spend/CPL stats right */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap', paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
          {/* Click-quality / CPULC thresholds (4) */}
          <FeaturedStat
            label="$50+ kill"
            value={fmt$(b.thresholdS1)}
            sub="CPULC ≥"
          />
          <FeaturedStat
            label="Min CPULC"
            value={fmt$(b.minCpulc)}
            sub={b.cpulc ? `25% × baseline (bait)` : 'no baseline (bait)'}
          />
          <FeaturedStat
            label="$150+ kill"
            value={fmt$(b.thresholdS2)}
            sub="CPULC ≥"
          />
          <FeaturedStat
            label="Outbound CTR"
            value={`< ${Math.round(OUTBOUND_CTR_RATIO * 100)}%`}
            sub="of link CTR (fake)"
            tone="warn"
          />

          <div style={{ width: 2, alignSelf: 'stretch', background: 'var(--border)', margin: '0 4px' }} />

          {/* Spend / CPL thresholds (2) */}
          <FeaturedStat
            label="No-leads kill"
            value={fmt$(b.noLeadsHardKill)}
            sub={b.cpl && b.cpl * NO_LEADS_HARD_MULT < CPL_TARGET ? `${NO_LEADS_HARD_MULT}× baseline` : `$${CPL_TARGET} cap`}
          />
          <FeaturedStat
            label="CPL hard"
            value={fmt$(b.cplHardKill)}
            sub={b.cpl ? `${CPL_HARD_MULT}× / $${CPL_HARD_CAP} cap` : 'no baseline'}
          />
        </div>
      </div>

      {isOpen && (
        <div style={{ borderTop: '1px solid var(--border)', overflow: 'auto', maxHeight: '70vh' }}>
          {visibleRows.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No adsets match current filters.</div>
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
                  <SortableTh keyName="outboundCtr" label="Outb-CTR" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="freq" label="Freq" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="reach" label="Reach" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="results" label="Leads" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  <SortableTh keyName="cpl" label="CPL" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
                  {hasCompare && <th style={th}>Δ CPL</th>}
                  {hasCompare && <th style={th}>Δ leads</th>}
                  <th style={thL}>Reasons</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => {
                  const color = FLAG_COLORS[r.flag] || FLAG_COLORS.watch;
                  const cpulcMul = b?.cpulc && r.cpulc ? r.cpulc / b.cpulc : null;
                  // CPL coloring: red if at hard kill, default otherwise
                  const cplHardLine = b?.cplHardKill ?? CPL_HARD_CAP;
                  const cplOver = r.cpl != null && r.results >= 1 && r.cpl >= cplHardLine;
                  const dCpl = r.fatigue?.cplDelta;
                  const dLeads = r.fatigue?.leadsDelta;
                  return (
                    <tr key={i} style={{ background: color.bg, borderLeft: `3px solid ${color.border}` }}>
                      <td style={tdL}>
                        {color.label && <span style={{ background: color.border, color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{color.label}</span>}
                      </td>
                      <td style={{ ...tdL, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.name}>{r.name}</td>
                      <td style={td}>${r.spend.toFixed(0)}</td>
                      <td style={{ ...td, fontSize: 10, color: 'var(--text-muted)' }}>{r.stage}</td>
                      <td style={td}>
                        {r.quad && <span style={{ background: r.quad.color, color: '#fff', padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700 }} title={r.quad.label}>{r.quad.code}</span>}
                      </td>
                      <td style={td}>{fmt$(r.cpulc)}</td>
                      <td style={{ ...td, color: cpulcMul && cpulcMul >= 3 ? '#dc2626' : cpulcMul && cpulcMul >= 2 ? '#f59e0b' : 'var(--text-muted)', fontWeight: cpulcMul && cpulcMul >= 2 ? 600 : 400 }}>
                        {cpulcMul ? `${cpulcMul.toFixed(1)}×` : '—'}
                      </td>
                      <td style={td}>{fmt$(r.cpm)}</td>
                      <td style={td}>{fmtPct(r.uctr)}</td>
                      <td style={{ ...td, color: r.uctr && r.outboundCtr != null && r.uctr > 0 && (r.outboundCtr / r.uctr) <= OUTBOUND_CTR_RATIO ? '#dc2626' : 'var(--text)' }}>
                        {fmtPct(r.outboundCtr)}
                      </td>
                      <td style={td}>{r.freq ? r.freq.toFixed(2) : '—'}</td>
                      <td style={td}>{r.reach ? r.reach.toLocaleString() : '—'}</td>
                      <td style={td}>{fmtNum(r.results)}</td>
                      <td style={{ ...td, color: cplOver ? '#dc2626' : 'var(--text)', fontWeight: cplOver ? 600 : 400 }}>{fmt$(r.cpl)}</td>
                      {hasCompare && <td style={{ ...td, color: dCpl == null ? 'var(--text-muted)' : dCpl > 0.5 ? '#dc2626' : dCpl > 0 ? '#f59e0b' : '#16a34a' }}>{fmtDelta(dCpl) || '—'}</td>}
                      {hasCompare && <td style={{ ...td, color: dLeads == null ? 'var(--text-muted)' : dLeads < -0.5 ? '#dc2626' : dLeads < 0 ? '#f59e0b' : '#16a34a' }}>{fmtDelta(dLeads) || '—'}</td>}
                      <td style={{ ...tdL, fontSize: 11, color: color.text, maxWidth: 340, whiteSpace: 'normal' }}>
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

function FeaturedStat({ label, value, sub, tone = 'danger' }) {
  const palette = tone === 'warn'
    ? { bg: 'rgba(245,158,11,0.10)', border: '#f59e0b', text: '#b45309' }
    : { bg: 'rgba(220,38,38,0.10)', border: '#dc2626', text: '#991b1b' };
  return (
    <div style={{
      padding: '8px 16px',
      background: palette.bg,
      border: `2px solid ${palette.border}`,
      borderRadius: 10,
      minWidth: 130,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: palette.text }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: palette.text, lineHeight: 1.05 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, sub }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 70 }}>
      <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', lineHeight: 1.1 }}>{value}</span>
      {sub && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>{sub}</span>}
    </div>
  );
}

function StatBlock({ label, value, sub, critical, valueColor }) {
  return (
    <div style={{ minWidth: 95, padding: '6px 12px', background: critical ? 'rgba(220,38,38,0.06)' : 'transparent', border: critical ? '1px solid rgba(220,38,38,0.25)' : '1px solid transparent', borderRadius: 6 }}>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: critical ? '#dc2626' : 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: valueColor || (critical ? '#dc2626' : 'var(--text)'), lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  );
}

function CountBadge({ n, label, color, sub }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', background: color === 'var(--text-muted)' ? 'var(--bg)' : `${color}22`, border: `1px solid ${color === 'var(--text-muted)' ? 'var(--border)' : color}`, borderRadius: 6, padding: '4px 10px', minWidth: 50 }}>
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

const selectStyle = { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 8px', fontSize: 12, outline: 'none' };
const btnSm = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: 'var(--text-muted)' };

function Pill({ label, count, sub, color, active, onClick }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', background: active ? color : 'var(--surface)', border: `1px solid ${color === 'var(--text-muted)' ? 'var(--border)' : color}`, borderRadius: 8, padding: '6px 12px', cursor: 'pointer', color: active ? '#fff' : 'var(--text)', minWidth: 95 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.85 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.1 }}>{count}</div>
      {sub && <div style={{ fontSize: 10, opacity: 0.75 }}>{sub}</div>}
    </button>
  );
}
