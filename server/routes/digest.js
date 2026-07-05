import { Router } from 'express';
import fetch from 'node-fetch';
import { google } from 'googleapis';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fetchDailyInsights } from './facebook.js';
import { runIncrementalNextSteps, getAuthClient, SHEET_ID, EVENTS_TAB } from './hyros.js';

const router = Router();
const FB_API = 'https://graph.facebook.com/v19.0';
const DATA_DIR = process.env.DATA_DIR || './data';
const ROSTER_FILE = path.join(DATA_DIR, 'digest-roster.json');
const DIGEST_TZ = process.env.DIGEST_TZ || 'America/Los_Angeles';
const PUBLIC_URL = process.env.SERVER_PUBLIC_URL || 'https://scalecases-server.onrender.com';
// Window: today plus the previous N days — the timeframe the whole digest reads from
const WINDOW_DAYS_BACK = 4;

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
function fmtCpl(spend, leads) { return leads > 0 ? '$' + Math.round(spend / leads) : '—'; }

// ── Data collectors ───────────────────────────────────────────────────────────

// Adset metadata (names, status, budgets) via our own cached endpoint
async function getAdsetMeta() {
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/facebook/adsets?metadata_only=true`);
  if (!r.ok) throw new Error(`adsets meta: ${r.status}`);
  return r.json();
}

// Ledger stage-leads (the /next-steps definition): counts per adset and per date
async function getLedger(fromDate) {
  const auth   = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const data   = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${EVENTS_TAB}!A:J` });
  const rows   = (data.data.values || []).slice(1);
  const byAdsetByDate = {}, byDate = {}, windowByAdset = {};
  for (const r of rows) {
    const [, date, adsetId, state] = r;
    if (!date || date < fromDate) continue;
    byDate[date] = (byDate[date] || 0) + 1;
    if (adsetId) {
      if (!byAdsetByDate[date]) byAdsetByDate[date] = {};
      byAdsetByDate[date][adsetId] = (byAdsetByDate[date][adsetId] || 0) + 1;
      windowByAdset[adsetId] = (windowByAdset[adsetId] || 0) + 1;
    }
  }
  return { byAdsetByDate, byDate, windowByAdset };
}

// ── Roster: every ACTIVE adset with spend in the window, numbered by spend ───
// Each entry carries the four stat groups: spend, leads (FB & Hyros),
// CPL (FB & Hyros), cost per unique link click.
function buildRoster(windowRows, ledgerWindow, metaById) {
  const agg = {};
  for (const r of windowRows) {
    const id = r.adset_id;
    if (!agg[id]) agg[id] = { id, name: r.adset_name, campaign: r.campaign_name, spend: 0, fbLeads: 0, uclicks: 0, impressions: 0 };
    agg[id].spend       += parseFloat(r.spend) || 0;
    agg[id].fbLeads     += r.results || 0;
    agg[id].uclicks     += parseFloat(r.unique_inline_link_clicks) || 0;
    agg[id].impressions += parseFloat(r.impressions) || 0;
  }
  const entries = Object.values(agg)
    .filter(a => a.spend > 0 && (metaById[a.id]?.effectiveStatus || metaById[a.id]?.status) === 'ACTIVE')
    .map(a => ({
      ...a,
      hyLeads: ledgerWindow[a.id] || 0,
      cpm:     a.impressions > 0 ? (a.spend / a.impressions) * 1000 : 0,
      cpulc:   a.uclicks > 0 ? a.spend / a.uclicks : null,
    }))
    .sort((a, b) => b.spend - a.spend);
  entries.forEach((e, i) => { e.n = i + 1; });
  return entries;
}

// Kill/watch rules over the window. Lead-based rules use the BETTER of FB and
// Hyros counts so an adset FB under-reports is not killed while Hyros shows leads.
function flagFor(e) {
  const leads = Math.max(e.fbLeads, e.hyLeads);
  const cpl   = leads > 0 ? e.spend / leads : null;
  if (e.spend >= 300 && leads === 0)     return { level: 'kill',  reason: `${fmtMoney(e.spend)} spent, 0 leads` };
  if (e.spend >= 50 && e.uclicks === 0)  return { level: 'kill',  reason: `${fmtMoney(e.spend)} spent, 0 link clicks` };
  if (e.spend >= 50 && e.cpm >= 150)     return { level: 'kill',  reason: `CPM ${fmtMoney(e.cpm)}` };
  if (cpl != null && cpl >= 600)         return { level: 'kill',  reason: `CPL ${fmtMoney(cpl)}` };
  if (e.spend >= 200 && leads === 0)     return { level: 'watch', reason: `${fmtMoney(e.spend)} spent, 0 leads` };
  if (cpl != null && cpl >= 450)         return { level: 'watch', reason: `CPL ${fmtMoney(cpl)}` };
  if (e.spend >= 100 && e.cpulc != null && e.cpulc >= 7) return { level: 'watch', reason: `CPULC $${e.cpulc.toFixed(2)}` };
  return null;
}

function fmtEntry(e, reason) {
  const tag = `[${extractBrand(e.campaign)} ${extractState(e.campaign) || '?'}]`;
  const stats = `${fmtMoney(e.spend)} | FB ${e.fbLeads}/${fmtCpl(e.spend, e.fbLeads)} | Hy ${e.hyLeads}/${fmtCpl(e.spend, e.hyLeads)} | ULC ${e.cpulc != null ? '$' + e.cpulc.toFixed(2) : '—'}`;
  return `#${e.n} ${e.name} ${tag}\n   ${stats}${reason ? ` — ${reason}` : ''}`;
}

function saveRoster(entries) {
  const data = { ts: new Date().toISOString(), entries: entries.map(e => ({ n: e.n, id: e.id, name: e.name, campaign: e.campaign })) };
  _roster = data;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ROSTER_FILE, JSON.stringify(data));
  } catch (e) { console.warn('[digest] roster write failed:', e.message); }
}
function loadRoster() {
  if (_roster) return _roster;
  try { _roster = JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')); } catch { /* none */ }
  return _roster;
}
let _roster = null;
let _lastFullList = null;

// ── Compose ───────────────────────────────────────────────────────────────────
async function buildDigest() {
  const today = tzToday(), windowStart = tzDaysAgo(WINDOW_DAYS_BACK);

  const [meta, windowRows, ledger] = await Promise.all([
    getAdsetMeta(),
    fetchDailyInsights({ level: 'adset', start: windowStart, end: today }),
    getLedger(windowStart).catch(e => { console.warn('[digest] ledger:', e.message); return null; }),
  ]);
  const metaById = Object.fromEntries(meta.map(a => [a.id, a]));

  const roster = buildRoster(windowRows, ledger?.windowByAdset || {}, metaById);
  saveRoster(roster);

  const flagged = roster.map(e => ({ e, flag: flagFor(e) })).filter(x => x.flag);
  const kills   = flagged.filter(x => x.flag.level === 'kill');
  const watches = flagged.filter(x => x.flag.level === 'watch');

  const L = [];
  const now = new Date().toLocaleString('en-US', { timeZone: DIGEST_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const windowLabel = `${windowStart.slice(5).replace('-', '/')}–${today.slice(5).replace('-', '/')}`;
  L.push(`📊 SCALECASES DIGEST — ${now}`);
  L.push(`Window ${windowLabel} · stats: spend | FB leads/CPL | Hyros leads/CPL | cost per unique link click`);

  L.push('', `🔴 KILL CANDIDATES: ${kills.length ? '' : 'none'}`);
  for (const { e, flag } of kills.slice(0, 10)) L.push(fmtEntry(e, flag.reason));
  if (kills.length > 10) L.push(`…and ${kills.length - 10} more (reply "list")`);

  L.push('', `🟡 WATCH: ${watches.length ? '' : 'none'}`);
  for (const { e, flag } of watches.slice(0, 8)) L.push(fmtEntry(e, flag.reason));
  if (watches.length > 8) L.push(`…and ${watches.length - 8} more (reply "list")`);

  // Campaign-level cursory glance: FB leads + CPL per campaign, same window
  const camps = {};
  for (const r of windowRows) {
    const name = r.campaign_name || '?';
    camps[name] = camps[name] || { spend: 0, leads: 0 };
    camps[name].spend += parseFloat(r.spend) || 0;
    camps[name].leads += r.results || 0;
  }
  L.push('', `📋 CAMPAIGNS (FB, ${windowLabel}):`);
  const cRows = Object.entries(camps).filter(([, v]) => v.spend > 0).sort((a, b) => b[1].spend - a[1].spend);
  for (const [name, v] of cRows)
    L.push(`  ${name}: ${v.leads} leads · ${v.leads > 0 ? 'CPL ' + fmtCpl(v.spend, v.leads) : fmtMoney(v.spend) + ' spent, no leads'}`);
  const totLeads = cRows.reduce((s, [, v]) => s + v.leads, 0);
  const totSpend = cRows.reduce((s, [, v]) => s + v.spend, 0);
  L.push(`  TOTAL: ${totLeads} leads · CPL ${fmtCpl(totSpend, totLeads)}`);

  L.push('', `Reply "kill 3 7 12" to pause adsets by number · "list" for all ${roster.length} adsets · "run" for a fresh digest`);

  // Full numbered roster, sent only on request ("list")
  _lastFullList = [`All active adsets, window ${windowLabel} (spend | FB ld/CPL | Hy ld/CPL | ULC):`, ...roster.map(e => fmtEntry(e))].join('\n');

  return L.join('\n');
}

// ── FB write: pause adsets by roster number ──────────────────────────────────
async function pauseByNumbers(nums) {
  const roster = loadRoster();
  if (!roster?.entries?.length) return 'No roster available — run a digest first.';
  const results = [];
  for (const n of nums) {
    const entry = roster.entries.find(e => e.n === n);
    if (!entry) { results.push(`#${n}: not in the current list (1–${roster.entries.length})`); continue; }
    try {
      // FB_WRITE_TOKEN: system-user token from the unpublished dev-mode app
      // with ads_management; the published read app's token stays untouched
      const token = process.env.FB_WRITE_TOKEN || process.env.FB_ACCESS_TOKEN;
      const r = await fetch(`${FB_API}/${entry.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ status: 'PAUSED', access_token: token }),
      });
      const j = await r.json();
      if (j.success) results.push(`✅ #${n} PAUSED — ${entry.name}`);
      else {
        const msg = j.error?.message || JSON.stringify(j).slice(0, 120);
        const perm = /permission|#200|#10\b|requires/i.test(msg);
        results.push(`❌ #${n} ${entry.name}: ${perm ? (process.env.FB_WRITE_TOKEN ? 'FB_WRITE_TOKEN lacks ads_management or Manage-campaigns access on this ad account' : 'set FB_WRITE_TOKEN — a system-user token with ads_management from the unpublished app') : msg}`);
      }
    } catch (e) { results.push(`❌ #${n} ${entry.name}: ${e.message}`); }
  }
  return results.join('\n');
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function tgSecret() {
  return crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN || 'none').digest('hex').slice(0, 32);
}

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

// Register the webhook so replies to the bot reach POST /api/digest/telegram
async function registerTelegramWebhook() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${PUBLIC_URL}/api/digest/telegram`, secret_token: tgSecret(), allowed_updates: ['message'] }),
    });
    const j = await r.json();
    console.log('[digest] telegram webhook:', j.ok ? 'registered' : JSON.stringify(j).slice(0, 200));
  } catch (e) { console.warn('[digest] webhook registration failed:', e.message); }
}
setTimeout(registerTelegramWebhook, 10_000);

// Inbound commands from the user
router.post('/telegram', async (req, res) => {
  res.json({ ok: true }); // ack immediately; Telegram retries otherwise
  try {
    if (req.get('X-Telegram-Bot-Api-Secret-Token') !== tgSecret()) return;
    const msg = req.body?.message;
    if (!msg?.text) return;
    if (String(msg.chat?.id) !== String(process.env.TELEGRAM_CHAT_ID)) return;

    const text = msg.text.trim().toLowerCase();
    if (/^(digest|status)\b/.test(text)) {
      await sendTelegram(_digest.lastText || 'No digest yet — reply "run".');
    } else if (/^list\b/.test(text)) {
      await sendTelegram(_lastFullList || 'No roster yet — reply "run" first.');
    } else if (/^run\b/.test(text)) {
      if (_digest.running) await sendTelegram('Already running — digest arriving shortly.');
      else {
        await sendTelegram('On it — fresh digest in ~2 minutes.');
        runDigest().catch(e => console.error('[digest]', e.message));
      }
    } else if (/\b(kill|pause|stop|turn ?off|off)\b/.test(text)) {
      const nums = [...text.matchAll(/\d+/g)].map(m => parseInt(m[0], 10));
      if (!nums.length) await sendTelegram('Which numbers? e.g. "kill 3 7 12"');
      else await sendTelegram(await pauseByNumbers(nums));
    } else {
      await sendTelegram('Commands: "kill 3 7 12" (pause by number) · "list" (all adsets) · "digest" (resend) · "run" (fresh digest)');
    }
  } catch (e) { console.error('[digest] telegram handler:', e.message); }
});

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

// GET /api/digest/list — full numbered roster as plain text
router.get('/list', (req, res) => {
  res.type('text/plain').send(_lastFullList || 'No roster yet — run a digest first.');
});

router.get('/status', (req, res) => {
  res.json({
    running: _digest.running,
    lastRun: _digest.lastRun,
    lastError: _digest.lastError,
    lastDelivery: _digest.lastDelivery,
    scheduledTimes: DIGEST_TIMES,
    timezone: DIGEST_TZ,
    windowDaysBack: WINDOW_DAYS_BACK,
    rosterSize: loadRoster()?.entries?.length || 0,
    telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  });
});

export default router;
