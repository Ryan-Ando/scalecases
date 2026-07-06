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

// FB ad account id → display name, fetched once and kept for the process
// lifetime. DIGEST_ACCOUNT_ORDER (comma-separated name fragments, matched
// case-insensitively) controls group order in the digest.
const ACCOUNT_ORDER = (process.env.DIGEST_ACCOUNT_ORDER || 'b2c,zem,acc').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
let _accountNames = null;

async function getAccountNames(accountIds) {
  if (_accountNames) return _accountNames;
  const names = {};
  for (const id of accountIds) {
    try {
      const r = await fetch(`${FB_API}/${id}?fields=name&access_token=${process.env.FB_ACCESS_TOKEN}`);
      const j = await r.json();
      names[id] = j.name || id;
    } catch { names[id] = id; }
  }
  _accountNames = names;
  return names;
}

function accountRank(name) {
  const n = (name || '').toLowerCase();
  const i = ACCOUNT_ORDER.findIndex(frag => n.includes(frag));
  return i === -1 ? ACCOUNT_ORDER.length : i;
}

// Adset metadata (names, status, budgets). force bypasses the 2h server cache
// so a digest never judges "active" from stale statuses.
async function getAdsetMeta(force = false) {
  const r = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}/api/facebook/adsets?metadata_only=true${force ? '&force=true' : ''}`);
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
    getAdsetMeta(force),
    fetchDailyInsights({ level: 'adset', start: windowStart, end: today }),
    getLedger(windowStart).catch(e => { console.warn('[digest] ledger:', e.message); return null; }),
  ]);
  const metaById = Object.fromEntries(meta.map(a => [a.id, a]));
  const ledgerWindow = ledger?.windowByAdset || {};
  // Ledger failure means Hyros leads would all read 0 — with hyros as the
  // rules' lead source that would flag everything, so surface it loudly
  const ledgerFailed = !ledger;

  const agg = {};
  for (const r of windowRows) {
    const id = r.adset_id;
    if (!agg[id]) agg[id] = { id, name: r.adset_name, campaign: r.campaign_name, account: r.account, spend: 0, fbLeads: 0, uclicks: 0, impressions: 0 };
    agg[id].spend       += parseFloat(r.spend) || 0;
    agg[id].fbLeads     += r.results || 0;
    agg[id].uclicks     += parseFloat(r.unique_inline_link_clicks) || 0;
    agg[id].impressions += parseFloat(r.impressions) || 0;
  }
  const entries = Object.values(agg)
    // Missing metadata (brand-new adset, partial meta fetch) must NOT hide an
    // adset — include it rather than silently dropping a potential kill
    .filter(a => a.spend > 0 && (!metaById[a.id] || (metaById[a.id].effectiveStatus || metaById[a.id].status) === 'ACTIVE'))
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
    entries, windowRows, metaById, ledger, windowLabel, ledgerFailed,
    failedAccounts: windowRows.failedAccounts || [],
  };
  return _statsCache;
}

// Kill/watch rules over the window. Lead-based rules use the BETTER of FB and
// Hyros counts so an adset FB under-reports is not killed while Hyros shows leads.
// ── KPI rules — user-editable via Telegram ("rules", "set kill cpl 700") ─────
// Plain threshold logic, no AI: every rule is an explicit numeric comparison.
const KPI_FILE = path.join(DATA_DIR, 'digest-kpis.json');
const DEFAULT_KPIS = {
  kill_noleads_spend:  300,  // KILL: spend ≥ this with 0 leads
  kill_noclicks_spend: 50,   // KILL: spend ≥ this with 0 unique link clicks
  kill_cpm:            150,  // KILL: CPM ≥ this (at $50+ spend)
  kill_cpl:            600,  // KILL: CPL ≥ this
  watch_noleads_spend: 200,  // WATCH: spend ≥ this with 0 leads
  watch_cpl:           450,  // WATCH: CPL ≥ this
  watch_cpulc:         7,    // WATCH: cost per unique link click ≥ this…
  watch_cpulc_spend:   100,  // …at spend ≥ this
  leads_source: 'hyros',     // which lead count the rules use: hyros | fb | best
};
let KPIS = { ...DEFAULT_KPIS };
try { KPIS = { ...DEFAULT_KPIS, ...JSON.parse(fs.readFileSync(KPI_FILE, 'utf8')) }; } catch { /* defaults */ }

function saveKpis() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KPI_FILE, JSON.stringify(KPIS));
  } catch (e) { console.warn('[digest] kpi write failed:', e.message); }
}

const KPI_ALIASES = {
  kill_cpl:            ['kill cpl'],
  watch_cpl:           ['watch cpl'],
  kill_cpm:            ['kill cpm'],
  kill_noleads_spend:  ['kill noleads', 'kill no leads', 'kill noleads spend'],
  watch_noleads_spend: ['watch noleads', 'watch no leads', 'watch noleads spend'],
  kill_noclicks_spend: ['kill noclicks', 'kill no clicks', 'kill noclicks spend'],
  watch_cpulc:         ['watch cpulc', 'watch ulc'],
  watch_cpulc_spend:   ['watch cpulc spend', 'watch ulc spend'],
};

function rulesText() {
  const srcDesc = { hyros: 'HYROS stage leads', fb: 'FB leads', best: 'better of FB / Hyros' }[KPIS.leads_source] || KPIS.leads_source;
  return [
    'CURRENT RULES (all plain thresholds, no AI)',
    `Window: today + previous ${WINDOW_DAYS_BACK} days`,
    `Leads for rules: ${srcDesc}   [set leads source hyros/fb/best]`,
    '',
    'KILL when any of:',
    `  spend ≥ $${KPIS.kill_noleads_spend} with 0 leads      [kill noleads]`,
    `  spend ≥ $${KPIS.kill_noclicks_spend} with 0 link clicks  [kill noclicks]`,
    `  CPM ≥ $${KPIS.kill_cpm} (at $50+ spend)    [kill cpm]`,
    `  CPL ≥ $${KPIS.kill_cpl}                  [kill cpl]`,
    '',
    'WATCH when any of:',
    `  spend ≥ $${KPIS.watch_noleads_spend} with 0 leads      [watch noleads]`,
    `  CPL ≥ $${KPIS.watch_cpl}                  [watch cpl]`,
    `  ULC ≥ $${KPIS.watch_cpulc} at spend ≥ $${KPIS.watch_cpulc_spend}   [watch ulc / watch ulc spend]`,
    '',
    'Change one: "set kill cpl 700"',
    'Restore defaults: "reset rules"',
  ].join('\n');
}

function setKpiFromText(text) {
  const t = text.replace(/^set\s+/i, '').trim();
  const srcMatch = t.match(/^leads?\s+source\s+(hyros|fb|facebook|best)$/i);
  if (srcMatch) {
    const old = KPIS.leads_source;
    KPIS.leads_source = srcMatch[1].toLowerCase() === 'facebook' ? 'fb' : srcMatch[1].toLowerCase();
    saveKpis();
    return `✅ leads source: ${old} → ${KPIS.leads_source}\n\n${rulesText()}`;
  }
  const m = t.match(/(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return 'Give me a number, e.g. "set kill cpl 700" (or "set leads source hyros/fb/best")';
  const value = parseFloat(m[1]);
  const phrase = t.slice(0, m.index).trim().replace(/\s+/g, ' ').toLowerCase().replace(/\$/g, '');
  const key = Object.keys(KPI_ALIASES).find(k => KPI_ALIASES[k].includes(phrase));
  if (!key) return `Unknown rule "${phrase}". Valid: ${Object.values(KPI_ALIASES).map(a => a[0]).join(' · ')}`;
  if (value <= 0) return 'Value must be positive.';
  const old = KPIS[key];
  KPIS[key] = value;
  saveKpis();
  return `✅ ${KPI_ALIASES[key][0]}: $${old} → $${value}\n\n${rulesText()}`;
}

function flagFor(e) {
  const src   = KPIS.leads_source;
  const leads = src === 'fb' ? e.fbLeads : src === 'hyros' ? e.hyLeads : Math.max(e.fbLeads, e.hyLeads);
  const srcLabel = src === 'fb' ? 'FB' : src === 'hyros' ? 'Hyros' : (e.fbLeads >= e.hyLeads ? 'FB' : 'Hyros');
  const cpl   = leads > 0 ? e.spend / leads : null;
  // bold: which displayed fields to emphasize as the reason (vertical layout)
  const leadBold = src === 'fb' ? ['fbLeads'] : src === 'hyros' ? ['hyLeads'] : ['fbLeads', 'hyLeads'];
  const cplBold  = src === 'fb' ? ['fbCpl'] : src === 'hyros' ? ['hyCpl'] : (e.fbLeads >= e.hyLeads ? ['fbCpl'] : ['hyCpl']);
  if (e.spend >= KPIS.kill_noleads_spend && leads === 0)     return { level: 'kill',  bold: ['spend', ...leadBold], reason: `${fmtMoney(e.spend)} spent, 0 ${srcLabel} leads` };
  if (e.spend >= KPIS.kill_noclicks_spend && e.uclicks === 0) return { level: 'kill', bold: ['spend', 'ulc'], reason: `${fmtMoney(e.spend)} spent, 0 link clicks` };
  if (e.spend >= 50 && e.cpm >= KPIS.kill_cpm)               return { level: 'kill',  bold: ['cpm'], reason: `CPM ${fmtMoney(e.cpm)}` };
  if (cpl != null && cpl >= KPIS.kill_cpl)                   return { level: 'kill',  bold: cplBold, reason: `${srcLabel} CPL ${fmtMoney(cpl)}` };
  if (e.spend >= KPIS.watch_noleads_spend && leads === 0)    return { level: 'watch', bold: ['spend', ...leadBold], reason: `${fmtMoney(e.spend)} spent, 0 ${srcLabel} leads` };
  if (cpl != null && cpl >= KPIS.watch_cpl)                  return { level: 'watch', bold: cplBold, reason: `${srcLabel} CPL ${fmtMoney(cpl)}` };
  if (e.spend >= KPIS.watch_cpulc_spend && e.cpulc != null && e.cpulc >= KPIS.watch_cpulc) return { level: 'watch', bold: ['ulc'], reason: `CPULC $${e.cpulc.toFixed(2)}` };
  return null;
}

// Two-line row with fixed-width stat columns — rendered in a Telegram <pre>
// block so the stat columns align vertically across rows. Leads and CPL are
// separate columns within the FB group and within the Hy group.
function fmtEntry(n, e, reason) {
  const tag = `[${extractBrand(e.campaign)} ${extractState(e.campaign) || '?'}]`;
  const u   = e.cpulc != null ? '$' + e.cpulc.toFixed(2) : '—';
  const lines = [
    `${pS(n, 2)} ${e.name} ${tag}`,
    `   ${pS(fmtMoney(e.spend), 6)} ${pS(e.fbLeads, 3)} ${pS(fmtCpl(e.spend, e.fbLeads), 5)}  ${pS(e.hyLeads, 3)} ${pS(fmtCpl(e.spend, e.hyLeads), 5)}  ${pS(u, 6)}`,
  ];
  if (reason) lines.push(`      ⚠ ${reason}`);
  return lines.join('\n');
}

// Built with the same paddings as fmtEntry's stat line so columns line up
const STAT_HEADER = `   ${pS('SPEND', 6)} ${pS('FB', 3)} ${pS('CPL', 5)}  ${pS('HY', 3)} ${pS('CPL', 5)}  ${pS('ULC', 6)}`;

// Vertical card for the digest's kill/watch sections (HTML — allows <b> on
// the field(s) that triggered the flag). One field per line, blank line
// between ads.
function fmtEntryVertical(n, e, flag) {
  const bold = new Set(flag?.bold || []);
  const line = (key, label, val) => {
    const s = `${label}: ${val}`;
    return bold.has(key) ? `<b>${s}</b>` : s;
  };
  const L = [`${n}. ${escapeHtml(e.name)}`];
  L.push(line('campaign', 'Campaign', escapeHtml(e.campaign)));
  L.push(line('spend',    'Spend',    fmtMoney(e.spend)));
  L.push(line('fbLeads',  'FB leads', e.fbLeads));
  L.push(line('fbCpl',    'FB CPL',   fmtCpl(e.spend, e.fbLeads)));
  L.push(line('hyLeads',  'Hy leads', e.hyLeads));
  L.push(line('hyCpl',    'Hy CPL',   fmtCpl(e.spend, e.hyLeads)));
  L.push(line('ulc',      'ULC',      e.cpulc != null ? '$' + e.cpulc.toFixed(2) : '—'));
  if (bold.has('cpm')) L.push(`<b>CPM: ${fmtMoney(e.cpm)}</b>`);
  return L.join('\n');
}

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

const FOOTER = 'Reply "kill 2 5" (numbers above) · a campaign name for its ads · "list" all adsets · "rules" view/edit KPIs · "run" fresh digest';

// ── Compose ───────────────────────────────────────────────────────────────────
async function buildDigest() {
  const stats = await collectStats(true);
  const { entries, windowRows, metaById, ledger, windowLabel } = stats;

  // Group order: ad account (per DIGEST_ACCOUNT_ORDER) → campaign → spend
  const acctNames = await getAccountNames([...new Set(entries.map(e => e.account).filter(Boolean))]);
  const byGroup = (a, b) =>
    (accountRank(acctNames[a.e.account]) - accountRank(acctNames[b.e.account]))
    || (acctNames[a.e.account] || '').localeCompare(acctNames[b.e.account] || '')
    || a.e.campaign.localeCompare(b.e.campaign)
    || b.e.spend - a.e.spend;

  // Never truncate — every flagged adset always appears (chunking handles length)
  const flagged = entries.map(e => ({ e, flag: flagFor(e) })).filter(x => x.flag);
  const kills   = flagged.filter(x => x.flag.level === 'kill').sort(byGroup);
  const watches = flagged.filter(x => x.flag.level === 'watch').sort(byGroup);

  // Roster = exactly what this digest displays, numbered top to bottom
  const displayed = [...kills, ...watches];
  saveRoster(displayed.map(x => x.e), 'digest');

  // The digest is composed as Telegram HTML: kill/watch as vertical cards
  // (regular text so <b> works), campaign table in a <pre> grid.
  const L = [];
  const now = new Date().toLocaleString('en-US', { timeZone: DIGEST_TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  L.push(escapeHtml(`📊 SCALECASES DIGEST — ${now} · window ${windowLabel}`));
  L.push(escapeHtml(`Scanned ${entries.length} active adsets · rules count ${KPIS.leads_source === 'best' ? 'best-of' : KPIS.leads_source.toUpperCase()} leads`));
  if (stats.failedAccounts.length)
    L.push(escapeHtml(`⚠ INCOMPLETE — FB account(s) failed after retries: ${stats.failedAccounts.join(', ')}. Numbers are missing that account; reply "run" to retry.`));
  if (stats.ledgerFailed)
    L.push(escapeHtml(`⚠ HYROS LEDGER UNAVAILABLE — Hyros lead counts read as 0 this run, so lead-based flags are unreliable. Reply "run" to retry before killing anything.`));

  let n = 0;
  const pushSection = (items) => {
    let lastAcct = null;
    for (const { e, flag } of items) {
      const acct = acctNames[e.account] || e.account || '?';
      if (acct !== lastAcct) { L.push('', `<b>═══ ${escapeHtml(acct)} ═══</b>`); lastAcct = acct; }
      L.push('', fmtEntryVertical(++n, e, flag));
    }
  };
  L.push('', `🔴 KILL CANDIDATES: ${kills.length || 'none'}`);
  pushSection(kills);

  L.push('', `🟡 WATCH: ${watches.length || 'none'}`);
  pushSection(watches);

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
  L.push('', escapeHtml(`📋 CAMPAIGNS (${windowLabel}) — reply a name for its ads:`));
  // AVG = mean of FB CPL and Hyros CPL (whichever are defined); campaigns
  // sorted worst-first — no-lead campaigns at the very top, then AVG desc
  const avgCpl = v => {
    const parts = [];
    if (v.fb > 0) parts.push(v.spend / v.fb);
    if (v.hy > 0) parts.push(v.spend / v.hy);
    return parts.length ? parts.reduce((s, x) => s + x, 0) / parts.length : null;
  };
  const cRows = Object.entries(camps).filter(([, v]) => v.spend > 0)
    .sort((a, b) => (avgCpl(b[1]) ?? Infinity) - (avgCpl(a[1]) ?? Infinity));
  const nameW = Math.max(...cRows.map(([name]) => name.length), 5);
  const campRow = (name, v) => {
    const avg = avgCpl(v);
    return `${pE(name, nameW)} ${pS(v.fb, 3)} ${pS(fmtCpl(v.spend, v.fb), 5)}  ${pS(v.hy, 3)} ${pS(fmtCpl(v.spend, v.hy), 5)}  ${pS(avg != null ? '$' + Math.round(avg) : '—', 5)}`;
  };
  const table = [`${pE('', nameW)} ${pS('FB', 3)} ${pS('CPL', 5)}  ${pS('HY', 3)} ${pS('CPL', 5)}  ${pS('AVG', 5)}`];
  for (const [name, v] of cRows) table.push(campRow(name, v));
  const totFb    = cRows.reduce((s, [, v]) => s + v.fb, 0);
  const totHy    = cRows.reduce((s, [, v]) => s + v.hy, 0);
  const totSpend = cRows.reduce((s, [, v]) => s + v.spend, 0);
  table.push(campRow('TOTAL', { spend: totSpend, fb: totFb, hy: totHy }));
  L.push(`<pre>${escapeHtml(table.join('\n'))}</pre>`);

  L.push('', escapeHtml(FOOTER));
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
  L.push('', ` TOTAL`);
  L.push(`   ${pS(fmtMoney(spend), 6)} ${pS(fb, 3)} ${pS(fmtCpl(spend, fb), 5)}  ${pS(hy, 3)} ${pS(fmtCpl(spend, hy), 5)}`);
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

function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// mode 'plain': raw text. 'mono': escape everything and wrap in <pre> (grid
// views). 'html': text is already Telegram HTML (digest — vertical cards with
// <b> plus an embedded <pre> table). Chunks split on line boundaries; a split
// inside a <pre> block closes and reopens the tag.
async function sendTelegram(text, { mode = 'plain' } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return { sent: false, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };

  const chunks = [];
  if (mode === 'plain') {
    for (let i = 0; i < text.length; i += 4000) chunks.push(text.slice(i, i + 4000));
  } else {
    let cur = [], len = 0, inPre = false;
    for (const ln of text.split('\n')) {
      if (len + ln.length + 1 > 3500 && cur.length) {
        if (inPre) cur.push('</pre>');
        chunks.push(cur.join('\n'));
        cur = inPre ? ['<pre>'] : [];
        len = inPre ? 6 : 0;
      }
      cur.push(ln); len += ln.length + 1;
      if (mode === 'html') {
        if (ln.includes('<pre>')) inPre = true;
        if (ln.includes('</pre>')) inPre = false;
      }
    }
    if (cur.length) chunks.push(cur.join('\n'));
  }

  for (const c of chunks) {
    const body = mode === 'mono'
      ? { chat_id: chat, text: `<pre>${escapeHtml(c)}</pre>`, parse_mode: 'HTML' }
      : mode === 'html'
      ? { chat_id: chat, text: c, parse_mode: 'HTML' }
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
      if (_digest.lastText) await sendTelegram(_digest.lastText, { mode: 'html' });
      else await sendTelegram('No digest yet — reply "run".');
    } else if (/^list\b/.test(text)) {
      await sendTelegram(await buildListView(), { mode: 'mono' });
    } else if (/^run\b/.test(text)) {
      if (_digest.running) await sendTelegram('Already running — digest arriving shortly.');
      else {
        await sendTelegram('On it — fresh digest in ~2 minutes.');
        runDigest().catch(e => console.error('[digest]', e.message));
      }
    } else if (/^(rules|kpis?)\b/.test(text)) {
      await sendTelegram(rulesText(), { mode: 'mono' });
    } else if (/^reset rules\b/.test(text)) {
      KPIS = { ...DEFAULT_KPIS };
      saveKpis();
      await sendTelegram(`✅ Rules reset to defaults.\n\n${rulesText()}`, { mode: 'mono' });
    } else if (/^set\b/.test(text)) {
      await sendTelegram(setKpiFromText(text), { mode: 'mono' });
    } else if (/^(kill|pause|stop|turn ?off|off)\b/.test(text)) {
      const nums = [...text.matchAll(/\d+/g)].map(m => parseInt(m[0], 10));
      if (!nums.length) await sendTelegram('Which numbers? e.g. "kill 2 5" — numbers refer to the last list I sent.');
      else await sendTelegram(await pauseByNumbers(nums));
    } else {
      // Anything else: try it as a campaign name
      const view = await buildCampaignView(text).catch(e => { console.error('[digest] campaign view:', e.message); return { text: null }; });
      if (view.text) await sendTelegram(view.text, { mode: 'mono' });
      else await sendTelegram(`No campaign matches "${msg.text.trim()}".\nCommands: a campaign name (e.g. "LSS TN") · "kill 2 5" (numbers from the last list) · "list" · "rules" · "set kill cpl 700" · "digest" · "run"`);
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
    _digest.lastDelivery = send ? await sendTelegram(text, { mode: 'html' }) : { sent: false, reason: 'send=false' };
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
  const plain = (_digest.lastText || 'No digest generated yet. POST /api/digest/run to create one.')
    .replace(/<b>/g, '**').replace(/<\/b>/g, '**')
    .replace(/<\/?pre>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  res.type('text/plain').send(plain);
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
