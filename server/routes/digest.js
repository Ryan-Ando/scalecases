import { Router } from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fetchDailyInsights } from './facebook.js';
import { runIncrementalNextSteps, getAuthClient, SHEET_ID, EVENTS_TAB } from './hyros.js';

const router = Router();
const HYROS_BASE = 'https://api.hyros.com/v1/api/v1.0';
const DATA_DIR = process.env.DATA_DIR || './data';
const SNAPSHOT_FILE = path.join(DATA_DIR, 'stage-snapshots.json');
const DIGEST_TZ = process.env.DIGEST_TZ || 'America/Los_Angeles';

const US_STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);

function extractState(campaignName) {
  const tokens = (campaignName || '').trim().split(/[-–—\s_/|]+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (US_STATES.has(tokens[i].toUpperCase())) return tokens[i].toUpperCase();
  }
  return null;
}
function extractBrand(campaignName) {
  const tokens = (campaignName || '').toUpperCase().split(/[-–—\s_/|]+/);
  if (tokens.includes('HALO')) return 'Halo';
  if (tokens.includes('BULKTIDE')) return 'Bulktide';
  return 'LSS';
}

function isoDateTZ(d) { return d.toLocaleDateString('en-CA', { timeZone: DIGEST_TZ }); }
function tzToday() { return isoDateTZ(new Date()); }
function tzDaysAgo(n) { const d = new Date(); d.setDate(d.getDate() - n); return isoDateTZ(d); }
function fmtMoney(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

// ── Data collectors ───────────────────────────────────────────────────────────

// Adset metadata (names, status, budgets) via our own cached endpoint
async function getAdsetMeta() {
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/facebook/adsets?metadata_only=true`);
  if (!r.ok) throw new Error(`adsets meta: ${r.status}`);
  return r.json();
}

// Campaign spend month-to-date via our own cached endpoint
async function getMtdSpend() {
  const monthStart = tzToday().slice(0, 8) + '01';
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/facebook/campaign-spend?since=${monthStart}&until=${tzToday()}`);
  if (!r.ok) throw new Error(`campaign-spend: ${r.status}`);
  return r.json();
}

// Per-adset daily FB insights over a window (direct fetch — 2×/day is cheap)
async function getAdsetDaily(start, end) {
  return fetchDailyInsights({ level: 'adset', start, end });
}

// Ledger stage-leads: count per adset and per state for dates >= fromDate
async function getLedger(fromDate) {
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const data   = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A:J` });
  const rows   = (data.data.values || []).slice(1);
  const byAdsetByDate = {}, byDate = {};
  for (const r of rows) {
    const [, date, adsetId, state] = r;
    if (!date || date < fromDate) continue;
    byDate[date] = (byDate[date] || 0) + 1;
    if (adsetId) {
      if (!byAdsetByDate[date]) byAdsetByDate[date] = {};
      byAdsetByDate[date][adsetId] = (byAdsetByDate[date][adsetId] || 0) + 1;
    }
  }
  return { byAdsetByDate, byDate };
}

// Hyros stage totals — snapshot to disk, return delta vs previous snapshot
async function getStageDelta() {
  const key = process.env.HYROS_API_KEY;
  if (!key) return null;
  const r = await fetch(`${HYROS_BASE}/stages`, { headers: { 'API-Key': key } });
  const j = await r.json();
  if (!Array.isArray(j.result)) return null;
  const current = Object.fromEntries(j.result.filter(s => s.amount != null).map(s => [s.name, s.amount]));

  let history = [];
  try { history = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { /* first run */ }
  const prev = history[history.length - 1];

  history.push({ ts: new Date().toISOString(), stages: current });
  if (history.length > 200) history = history.slice(-200);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(history));
  } catch (e) { console.warn('[digest] snapshot write failed:', e.message); }

  if (!prev) return { sinceTs: null, deltas: [] };
  const deltas = Object.entries(current)
    .map(([name, amt]) => ({ name, delta: amt - (prev.stages[name] || 0) }))
    .filter(d => d.delta > 0)
    .sort((a, b) => b.delta - a.delta);
  return { sinceTs: prev.ts, deltas };
}

// ── Kill rules (server-side digest variant of the Kill Analysis thresholds) ──
function evaluateKills(windowRows, metaById) {
  const agg = {};
  for (const r of windowRows) {
    const id = r.adset_id;
    if (!agg[id]) agg[id] = { id, name: r.adset_name, campaign: r.campaign_name, spend: 0, results: 0, uclicks: 0, impressions: 0 };
    agg[id].spend       += parseFloat(r.spend) || 0;
    agg[id].results     += r.results || 0;
    agg[id].uclicks     += parseFloat(r.unique_inline_link_clicks) || 0;
    agg[id].impressions += parseFloat(r.impressions) || 0;
  }
  const hard = [], soft = [];
  for (const a of Object.values(agg)) {
    const meta = metaById[a.id];
    if (!meta || (meta.effectiveStatus || meta.status) !== 'ACTIVE') continue;
    const cpm = a.impressions > 0 ? (a.spend / a.impressions) * 1000 : 0;
    const cpl = a.results > 0 ? a.spend / a.results : null;
    const cpulc = a.uclicks > 0 ? a.spend / a.uclicks : null;
    const row = { ...a, cpl, cpm };
    if (a.spend >= 300 && a.results === 0)      hard.push({ ...row, reason: `${fmtMoney(a.spend)} spent, 0 leads` });
    else if (a.spend >= 50 && a.uclicks === 0)  hard.push({ ...row, reason: `${fmtMoney(a.spend)} spent, 0 link clicks` });
    else if (a.spend >= 50 && cpm >= 150)       hard.push({ ...row, reason: `CPM ${fmtMoney(cpm)}` });
    else if (cpl != null && cpl >= 600)         hard.push({ ...row, reason: `CPL ${fmtMoney(cpl)}` });
    else if (a.spend >= 200 && a.results === 0) soft.push({ ...row, reason: `${fmtMoney(a.spend)} spent, 0 leads` });
    else if (cpl != null && cpl >= 450)         soft.push({ ...row, reason: `CPL ${fmtMoney(cpl)}` });
    else if (a.spend >= 100 && cpulc != null && cpulc >= 7) soft.push({ ...row, reason: `CPULC $${cpulc.toFixed(2)}` });
  }
  hard.sort((a, b) => b.spend - a.spend);
  soft.sort((a, b) => b.spend - a.spend);
  return { hard, soft };
}

// ── Compose ───────────────────────────────────────────────────────────────────
async function buildDigest() {
  const today = tzToday(), yesterday = tzDaysAgo(1), windowStart = tzDaysAgo(3);

  const [meta, windowRows, mtdSpend, ledger, stageDelta] = await Promise.all([
    getAdsetMeta(),
    getAdsetDaily(windowStart, yesterday),
    getMtdSpend().catch(e => { console.warn('[digest] mtd:', e.message); return []; }),
    getLedger(tzDaysAgo(3)).catch(e => { console.warn('[digest] ledger:', e.message); return null; }),
    getStageDelta().catch(e => { console.warn('[digest] stages:', e.message); return null; }),
  ]);
  const metaById = Object.fromEntries(meta.map(a => [a.id, a]));

  const L = [];
  const now = new Date().toLocaleString('en-US', { timeZone: DIGEST_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  L.push(`📊 SCALECASES DIGEST — ${now}`);

  // 1. Kill candidates (last 3 full days, active adsets only)
  const { hard, soft } = evaluateKills(windowRows, metaById);
  L.push('', `🔴 KILL (last 3d): ${hard.length ? '' : 'none'}`);
  for (const k of hard.slice(0, 8))
    L.push(`  ${k.name} [${extractBrand(k.campaign)} ${extractState(k.campaign) || '?'}] — ${k.reason}`);
  if (hard.length > 8) L.push(`  …and ${hard.length - 8} more`);
  L.push(`🟡 WATCH: ${soft.length ? '' : 'none'}`);
  for (const k of soft.slice(0, 6))
    L.push(`  ${k.name} [${extractBrand(k.campaign)} ${extractState(k.campaign) || '?'}] — ${k.reason}`);
  if (soft.length > 6) L.push(`  …and ${soft.length - 6} more`);

  // 2. Pacing: yesterday + MTD spend and live daily budget per brand-state
  const groups = {};
  for (const r of windowRows) {
    if (r.date_start !== yesterday) continue;
    const g = `${extractBrand(r.campaign_name)} ${extractState(r.campaign_name) || '?'}`;
    groups[g] = groups[g] || { yday: 0, mtd: 0, live: 0 };
    groups[g].yday += parseFloat(r.spend) || 0;
  }
  for (const c of mtdSpend) {
    const g = `${extractBrand(c.campaign_name)} ${extractState(c.campaign_name) || '?'}`;
    groups[g] = groups[g] || { yday: 0, mtd: 0, live: 0 };
    groups[g].mtd += c.spend || 0;
  }
  const seenCbo = new Set();
  for (const a of meta) {
    if ((a.effectiveStatus || a.status) !== 'ACTIVE') continue;
    const g = `${extractBrand(a.campaignName)} ${extractState(a.campaignName) || '?'}`;
    groups[g] = groups[g] || { yday: 0, mtd: 0, live: 0 };
    if (a.dailyBudget) groups[g].live += parseFloat(a.dailyBudget) / 100;
    else if (a.campaignDailyBudget && !seenCbo.has(a.campaignId)) {
      seenCbo.add(a.campaignId);
      groups[g].live += parseFloat(a.campaignDailyBudget) / 100;
    }
  }
  L.push('', '💰 SPEND (yday | MTD | live/day):');
  const gRows = Object.entries(groups).filter(([, v]) => v.yday > 0 || v.live > 0)
    .sort((a, b) => b[1].yday - a[1].yday);
  for (const [g, v] of gRows)
    L.push(`  ${g}: ${fmtMoney(v.yday)} | ${fmtMoney(v.mtd)} | ${fmtMoney(v.live)}`);
  const totYday = gRows.reduce((s, [, v]) => s + v.yday, 0);
  const totLive = gRows.reduce((s, [, v]) => s + v.live, 0);
  L.push(`  TOTAL: ${fmtMoney(totYday)} yday | ${fmtMoney(totLive)}/day live`);

  // 3. FB vs stage-leads cross-check for yesterday
  if (ledger) {
    const fbYdayByAdset = {};
    for (const r of windowRows) {
      if (r.date_start !== yesterday) continue;
      fbYdayByAdset[r.adset_id] = (fbYdayByAdset[r.adset_id] || 0) + (r.results || 0);
    }
    const fbTotal    = Object.values(fbYdayByAdset).reduce((s, n) => s + n, 0);
    const stageTotal = ledger.byDate[yesterday] || 0;
    L.push('', `🔎 LEADS yday: FB ${fbTotal} vs stage ${stageTotal}`);
    const stageYday = ledger.byAdsetByDate[yesterday] || {};
    const gaps = Object.entries(fbYdayByAdset)
      .filter(([id, n]) => n >= 3 && !(stageYday[id] > 0))
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
    for (const [id, n] of gaps)
      L.push(`  ⚠ ${metaById[id]?.name || id}: FB ${n}, stage 0 — check tracking`);
  }

  // 4. Stage-lead movement since the previous digest
  if (stageDelta?.deltas?.length) {
    const line = stageDelta.deltas.slice(0, 12).map(d => `${d.name} +${d.delta}`).join(', ');
    L.push('', `📈 STAGE LEADS since last digest: ${line}`);
  }

  return L.join('\n');
}

// ── Delivery ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
  for (let i = 0; i < text.length; i += 4000) {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(i, i + 4000) }),
    });
    const j = await r.json();
    if (!j.ok) return { sent: false, reason: j.description || 'telegram error' };
  }
  return { sent: true };
}

// ── Run + schedule ────────────────────────────────────────────────────────────
const _digest = { running: false, lastRun: null, lastText: null, lastError: null, lastDelivery: null };

async function runDigest({ send = true, sync = true } = {}) {
  if (_digest.running) return;
  _digest.running = true;
  try {
    if (sync) {
      console.log('[digest] running incremental stage-lead sync…');
      await runIncrementalNextSteps(2);
    }
    const text = await buildDigest();
    _digest.lastText = text;
    _digest.lastRun  = new Date().toISOString();
    _digest.lastError = null;
    _digest.lastDelivery = send ? await sendTelegram(text) : { sent: false, reason: 'send=false' };
    console.log(`[digest] done — delivery: ${JSON.stringify(_digest.lastDelivery)}`);
  } catch (e) {
    _digest.lastError = e.message;
    console.error('[digest] failed:', e.message);
  } finally {
    _digest.running = false;
  }
}

// Schedule: DIGEST_TIMES="07:30,16:00" (in DIGEST_TZ). Set DIGEST_TIMES=off to disable.
const DIGEST_TIMES = (process.env.DIGEST_TIMES || '07:30,16:00').split(',').map(s => s.trim()).filter(Boolean);
let _lastSlot = '';
if (!DIGEST_TIMES.includes('off')) {
  setInterval(() => {
    const hm = new Intl.DateTimeFormat('en-GB', { timeZone: DIGEST_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    if (!DIGEST_TIMES.includes(hm)) return;
    const slot = `${tzToday()} ${hm}`;
    if (slot === _lastSlot) return;
    _lastSlot = slot;
    runDigest().catch(e => console.error('[digest]', e.message));
  }, 60 * 1000);
}

// ── Routes ────────────────────────────────────────────────────────────────────
// POST /api/digest/run?send=0&sync=0 — trigger now (fire-and-forget)
router.post('/run', (req, res) => {
  if (_digest.running) return res.json({ ok: false, message: 'already running' });
  runDigest({ send: req.query.send !== '0', sync: req.query.sync !== '0' })
    .catch(e => console.error('[digest]', e.message));
  res.json({ ok: true, status: 'started' });
});

// GET /api/digest/latest — last digest as plain text (browser-friendly fallback)
router.get('/latest', (req, res) => {
  res.type('text/plain').send(_digest.lastText || 'No digest generated yet. POST /api/digest/run to create one.');
});

router.get('/status', (req, res) => {
  res.json({
    running: _digest.running,
    lastRun: _digest.lastRun,
    lastError: _digest.lastError,
    lastDelivery: _digest.lastDelivery,
    scheduledTimes: DIGEST_TIMES,
    timezone: DIGEST_TZ,
    telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  });
});

export default router;
