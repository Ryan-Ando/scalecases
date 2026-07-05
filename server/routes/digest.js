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
const pS = (v, w) => String(v).padStart(w);
const pE = (v, w) => String(v).padEnd(w);

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

// ── Stats: every ACTIVE adset with spend in the window, sorted by spend ──────
// Each entry carries the four stat groups: spend, leads (FB & Hyros),
// CPL (FB & Hyros), cost per unique link click. Numbering happens per VIEW
// (digest / list / campaign), not here — see saveRoster.
let _statsCache = null;
const STATS_TTL = 10 * 60 * 1000;

async function collectStats(force = false) {
  if (!force && _statsCache && Date.now() - _statsCache.ts < STATS_TTL) return _statsCache;
  const today = tzToday(), windowStart = tzDaysAgo(WINDOW_DAYS_BACK);

  const [meta, windowRows, ledger] = await Promise.all([
    getAdsetMeta(),
    fetchDailyInsights({ level: 'adset', start: windowStart, end: today }),
    getLedger(windowStart).catch(e => { console.warn('[digest] ledger:', e.message); return null; }),
  ]);
  const metaById = Object.fromEntries(meta.map(a => [a.id, a]));
  const ledgerWindow = ledger?.windowByAdset || {};

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

  const windowLabel = `${windowStart.slice(5).replace('-', '/')}–${today.slice(5).replace('-', '/')}`;
  _statsCache = {
    ts: Date.now(),
    entries, windowRows, metaById, ledger, windowLabel,
    failedAccounts: windowRows.failedAccounts || [],
  };
  return _statsCache;
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

// Two-line row with fixed-width stat columns — rendered in a Telegram <pre>
// block so the stat columns align vertically across rows.
function fmtEntry(n, e, reason) {
  const tag = `[${extractBrand(e.campaign)} ${extractState(e.campaign) || '?'}]`;
  const fb  = `${e.fbLeads}/${fmtCpl(e.spend, e.fbLeads)}`;
  const hy  = `${e.hyLeads}/${fmtCpl(e.spend, e.hyLeads)}`;
  const u   = e.cpulc != null ? '$' + e.cpulc.toFixed(2) : '—';
  const lines = [
    `${pS(n, 2)} ${e.name} ${tag}`,
    `   ${pS(fmtMoney(e.spend), 6)} FB ${pE(fb, 8)} Hy ${pE(hy, 8)} U${u}`,
  ];
  if (reason) lines.push(`      ⚠ ${reason}`);
  return lines.join('\n');
}

const STAT_HEADER = '    SPEND  FB ld/CPL   Hy ld/CPL  ULC';

// The roster is always THE LAST LIST SENT to the user, numbered 1..N in the
// order it was displayed. "kill N" resolves against it, whatever view it was.
function saveRoster(entries, label) {
  const data = {
    ts: new Date().toISOString(),
    label,
    entries: entries.map((e, i) => ({ n: i + 1, id: e.id, name: e.name, campaign: e.campaign })),
  };
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

const FOOTER = 'Reply "kill 2 5" (numbers above) · a campaign name for its ads · "list" all adsets · "run" fresh digest';

// ── Compose ───────────────────────────────────────────────────────────────────
async function buildDigest() {
  const stats = await collectStats(true);
  const { entries, windowRows, metaById, ledger, windowLabel } = stats;

  const flagged = entries.map(e => ({ e, flag: flagFor(e) })).filter(x => x.flag);
  const kills   = flagged.filter(x => x.flag.level === 'kill').slice(0, 10);
  const watches = flagged.filter(x => x.flag.level === 'watch').slice(0, 8);
  const nKillsHidden = flagged.filter(x => x.flag.level === 'kill').length - kills.length;
  const nWatchHidden = flagged.filter(x => x.flag.level === 'watch').length - watches.length;

  // Roster = exactly what this digest displays, numbered top to bottom
  const displayed = [...kills, ...watches];
  saveRoster(displayed.map(x => x.e), 'digest');

  const L = [];
  const now = new Date().toLocaleString('en-US', { timeZone: DIGEST_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  L.push(`📊 SCALECASES DIGEST — ${now}`);
  L.push(`Window ${windowLabel} · stats: spend | FB leads/CPL | Hyros leads/CPL | cost per unique link click`);
  if (stats.failedAccounts.length)
    L.push(`⚠ INCOMPLETE — FB account(s) failed after retries: ${stats.failedAccounts.join(', ')}. Numbers are missing that account; reply "run" to retry.`);

  let n = 0;
  L.push('', `🔴 KILL CANDIDATES: ${kills.length ? '' : 'none'}`);
  if (kills.length) L.push(STAT_HEADER);
  for (const { e, flag } of kills) L.push(fmtEntry(++n, e, flag.reason));
  if (nKillsHidden > 0) L.push(`…and ${nKillsHidden} more (reply "list")`);

  L.push('', `🟡 WATCH: ${watches.length ? '' : 'none'}`);
  if (watches.length) L.push(STAT_HEADER);
  for (const { e, flag } of watches) L.push(fmtEntry(++n, e, flag.reason));
  if (nWatchHidden > 0) L.push(`…and ${nWatchHidden} more (reply "list")`);

  // Campaign-level cursory glance: FB + Hyros leads/CPL per campaign, same window
  const camps = {};
  for (const r of windowRows) {
    const name = r.campaign_name || '?';
    camps[name] = camps[name] || { spend: 0, fb: 0, hy: 0 };
    camps[name].spend += parseFloat(r.spend) || 0;
    camps[name].fb    += r.results || 0;
  }
  for (const [adsetId, cnt] of Object.entries(ledger?.windowByAdset || {})) {
    const name = metaById[adsetId]?.campaignName;
    if (name && camps[name]) camps[name].hy += cnt;
  }
  L.push('', `📋 CAMPAIGNS (${windowLabel}) — reply a name for its ads:`);
  const cRows = Object.entries(camps).filter(([, v]) => v.spend > 0).sort((a, b) => b[1].spend - a[1].spend);
  const nameW = Math.max(...cRows.map(([name]) => name.length), 5);
  L.push(`${pE('', nameW)}  FB ld/CPL   Hy ld/CPL`);
  for (const [name, v] of cRows) {
    if (v.fb === 0 && v.hy === 0) L.push(`${pE(name, nameW)}  ${fmtMoney(v.spend)} spent, 0 leads`);
    else L.push(`${pE(name, nameW)}  ${pE(`${v.fb}/${fmtCpl(v.spend, v.fb)}`, 10)}  ${v.hy}/${fmtCpl(v.spend, v.hy)}`);
  }
  const totFb    = cRows.reduce((s, [, v]) => s + v.fb, 0);
  const totHy    = cRows.reduce((s, [, v]) => s + v.hy, 0);
  const totSpend = cRows.reduce((s, [, v]) => s + v.spend, 0);
  L.push(`${pE('TOTAL', nameW)}  ${pE(`${totFb}/${fmtCpl(totSpend, totFb)}`, 10)}  ${totHy}/${fmtCpl(totSpend, totHy)}`);

  L.push('', FOOTER);
  return L.join('\n');
}

// Campaign view: all active adsets in one campaign, numbered 1..N
async function buildCampaignView(query) {
  const stats = await collectStats();
  const campaigns = [...new Set(stats.entries.map(e => e.campaign))];
  const q = query.toLowerCase().trim();
  let matches = campaigns.filter(c => c.toLowerCase() === q);
  if (!matches.length) matches = campaigns.filter(c => c.toLowerCase().startsWith(q));
  if (!matches.length) matches = campaigns.filter(c => c.toLowerCase().includes(q));
  if (!matches.length) return { text: null };
  if (matches.length > 1)
    return { text: `Which campaign?\n${matches.map(c => `  ${c}`).join('\n')}` };

  const campaign = matches[0];
  const list = stats.entries.filter(e => e.campaign === campaign);
  saveRoster(list, `campaign ${campaign}`);
  const L = [`📂 ${campaign} — ${list.length} active adset${list.length !== 1 ? 's' : ''}, window ${stats.windowLabel}:`, '', STAT_HEADER];
  list.forEach((e, i) => L.push(fmtEntry(i + 1, e, flagFor(e)?.reason)));
  const spend = list.reduce((s, e) => s + e.spend, 0);
  const fb    = list.reduce((s, e) => s + e.fbLeads, 0);
  const hy    = list.reduce((s, e) => s + e.hyLeads, 0);
  L.push('', `TOTAL: ${fmtMoney(spend)} | FB ${fb}/${fmtCpl(spend, fb)} | Hy ${hy}/${fmtCpl(spend, hy)}`);
  L.push('', FOOTER);
  return { text: L.join('\n') };
}

// Full list view: every active adset, numbered 1..N by spend
async function buildListView() {
  const stats = await collectStats();
  saveRoster(stats.entries, 'full list');
  const L = [`All ${stats.entries.length} active adsets, window ${stats.windowLabel} (numbered for "kill N"):`, '', STAT_HEADER];
  stats.entries.forEach((e, i) => L.push(fmtEntry(i + 1, e, flagFor(e)?.reason)));
  L.push('', FOOTER);
  return L.join('\n');
}

// ── FB write: pause adsets by roster number ──────────────────────────────────
async function pauseByNumbers(nums) {
  const roster = loadRoster();
  if (!roster?.entries?.length) return 'No list to kill from — send "run", "list", or a campaign name first.';
  const results = [`Killing from: ${roster.label}`];
  for (const n of nums) {
    const entry = roster.entries.find(e => e.n === n);
    if (!entry) { results.push(`${n}: not in that list (1–${roster.entries.length})`); continue; }
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
      if (j.success) results.push(`✅ ${n}. PAUSED — ${entry.name} [${entry.campaign}]`);
      else {
        const msg = j.error?.message || JSON.stringify(j).slice(0, 120);
        const perm = /permission|#200|#10\b|requires/i.test(msg);
        results.push(`❌ ${n}. ${entry.name}: ${perm ? (process.env.FB_WRITE_TOKEN ? 'FB_WRITE_TOKEN lacks ads_management or Manage-campaigns access on this ad account' : 'set FB_WRITE_TOKEN — a system-user token with ads_management from the unpublished app') : msg}`);
      }
    } catch (e) { results.push(`❌ ${n}. ${entry.name}: ${e.message}`); }
  }
  return results.join('\n');
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function tgSecret() {
  return crypto.createHash('sha256').update(process.env.TELEGRAM_BOT_TOKEN || 'none').digest('hex').slice(0, 32);
}

function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// mono=true renders the message in a <pre> block (fixed-width font) so padded
// columns align like a grid. Chunks split on line boundaries, each chunk
// wrapped in its own <pre>.
async function sendTelegram(text, { mono = false } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };

  const chunks = [];
  if (mono) {
    let cur = [], len = 0;
    for (const ln of text.split('\n')) {
      if (len + ln.length + 1 > 3500 && cur.length) { chunks.push(cur.join('\n')); cur = []; len = 0; }
      cur.push(ln); len += ln.length + 1;
    }
    if (cur.length) chunks.push(cur.join('\n'));
  } else {
    for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  }

  for (const c of chunks) {
    const body = mono
      ? { chat_id: chat, text: `<pre>${escapeHtml(c)}</pre>`, parse_mode: 'HTML' }
      : { chat_id: chat, text: c };
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
      if (_digest.lastText) await sendTelegram(_digest.lastText, { mono: true });
      else await sendTelegram('No digest yet — reply "run".');
    } else if (/^list\b/.test(text)) {
      await sendTelegram(await buildListView(), { mono: true });
    } else if (/^run\b/.test(text)) {
      if (_digest.running) await sendTelegram('Already running — digest arriving shortly.');
      else {
        await sendTelegram('On it — fresh digest in ~2 minutes.');
        runDigest().catch(e => console.error('[digest]', e.message));
      }
    } else if (/^(kill|pause|stop|turn ?off|off)\b/.test(text)) {
      const nums = [...text.matchAll(/\d+/g)].map(m => parseInt(m[0], 10));
      if (!nums.length) await sendTelegram('Which numbers? e.g. "kill 2 5" — numbers refer to the last list I sent.');
      else await sendTelegram(await pauseByNumbers(nums));
    } else {
      // Anything else: try it as a campaign name
      const view = await buildCampaignView(text).catch(e => { console.error('[digest] campaign view:', e.message); return { text: null }; });
      if (view.text) await sendTelegram(view.text, { mono: true });
      else await sendTelegram(`No campaign matches "${msg.text.trim()}".\nCommands: a campaign name (e.g. "LSS TN") · "kill 2 5" (numbers from the last list) · "list" · "digest" · "run"`);
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
    _digest.lastDelivery = send ? await sendTelegram(text, { mono: true }) : { sent: false, reason: 'send=false' };
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
router.get('/list', async (req, res) => {
  try { res.type('text/plain').send(await buildListView()); }
  catch (e) { res.status(500).type('text/plain').send(`list failed: ${e.message}`); }
});

// GET /api/digest/campaign?name=LSS%20TN — campaign view as plain text
router.get('/campaign', async (req, res) => {
  try {
    const view = await buildCampaignView(String(req.query.name || ''));
    res.type('text/plain').send(view.text || `No campaign matches "${req.query.name}"`);
  } catch (e) { res.status(500).type('text/plain').send(`campaign view failed: ${e.message}`); }
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
