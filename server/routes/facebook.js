import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();
const FB_API = 'https://graph.facebook.com/v19.0';

// ── Date blacklist — these dates are excluded from all insights except the spend tracker ──
const BLACKLIST_DATES = new Set(['2026-03-28']);

function isoDateOffset(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function presetToRange(preset) {
  const today = new Date().toISOString().slice(0, 10);
  const ago = n => isoDateOffset(today, -n);
  switch (preset) {
    case 'today':      return { since: today, until: today };
    case 'yesterday':  return { since: ago(1), until: ago(1) };
    case 'last_7d':    return { since: ago(6), until: today };
    case 'last_14d':   return { since: ago(13), until: today };
    case 'last_30d':   return { since: ago(29), until: today };
    case 'this_month': {
      const d = new Date();
      return { since: `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01`, until: today };
    }
    case 'maximum':    return { since: isoDateOffset(today, -(36 * 30)), until: today };
    default:           return { since: ago(29), until: today };
  }
}

// ── Blacklist deduction cache ────────────────────────────────────────────────
// Stores per-entity deductions for each blacklisted date. Populated lazily and
// kept for the lifetime of the server process — blacklisted dates are fixed past
// dates whose FB data will never change.
const ADDITIVE_FIELDS = ['spend','impressions','reach','clicks','unique_inline_link_clicks'];
const _blacklistDeductions = {}; // level:filtersKey → { entityId: { field: num, actions: [...] } }

async function getBlacklistDeductions(level, filters = {}) {
  const key = `${level}:${JSON.stringify(filters)}`;
  if (_blacklistDeductions[key]) return _blacklistDeductions[key];

  const deductions = {};
  for (const date of BLACKLIST_DATES) {
    const rows = await fetchInsightsRaw(level, null, filters, { since: date, until: date });
    for (const row of rows) {
      const id = row.campaign_id || row.adset_id || row.ad_id;
      if (!id) continue;
      if (!deductions[id]) deductions[id] = { actions: [] };
      for (const f of ADDITIVE_FIELDS) {
        deductions[id][f] = (deductions[id][f] || 0) + (parseFloat(row[f]) || 0);
      }
      for (const a of (row.actions || [])) {
        const ex = deductions[id].actions.find(x => x.action_type === a.action_type);
        if (ex) ex.value = String(parseFloat(ex.value || 0) + parseFloat(a.value || 0));
        else deductions[id].actions.push({ ...a });
      }
    }
  }
  _blacklistDeductions[key] = deductions;
  return deductions;
}

// Subtracts blacklist deductions from a raw insights array.
function applyBlacklistDeductions(rows, deductions) {
  return rows.map(row => {
    const id  = row.campaign_id || row.adset_id || row.ad_id;
    const ded = deductions[id];
    if (!ded) return row;
    const out = { ...row };
    // clear rate fields — values will be wrong after subtraction anyway; recomputed downstream
    delete out.cpm; delete out.ctr; delete out.unique_ctr;
    delete out.frequency; delete out.cost_per_unique_inline_link_click; delete out.cost_per_result;
    for (const f of ADDITIVE_FIELDS) {
      if (out[f] != null) out[f] = String(Math.max(0, parseFloat(out[f] || 0) - (ded[f] || 0)));
    }
    if (ded.actions.length && out.actions) {
      out.actions = out.actions.map(a => {
        const d = ded.actions.find(x => x.action_type === a.action_type);
        if (!d) return a;
        return { ...a, value: String(Math.max(0, parseFloat(a.value || 0) - parseFloat(d.value || 0))) };
      });
    }
    // Recompute ratio metrics from the adjusted additive fields
    const spend   = parseFloat(out.spend)   || 0;
    const impr    = parseFloat(out.impressions) || 0;
    const reach   = parseFloat(out.reach)   || 0;
    const uclicks = parseFloat(out.unique_inline_link_clicks) || 0;
    if (impr  > 0) out.cpm       = String(((spend / impr)  * 1000).toFixed(4));
    if (impr  > 0 && reach > 0) out.frequency  = String((impr / reach).toFixed(4));
    if (reach > 0) out.unique_ctr = String(((uclicks / reach) * 100).toFixed(4));
    if (uclicks > 0) out.cost_per_unique_inline_link_click = String((spend / uclicks).toFixed(4));
    return out;
  });
}

// Returns true if the given date range contains any blacklisted date.
function rangeContainsBlacklist(since, until) {
  for (const d of BLACKLIST_DATES) if (d >= since && d <= until) return true;
  return false;
}

// ── Server-side in-memory cache for FB API responses ────────────────────────
// Keyed by request path+params. TTL: 2 hours. Survives across client reloads.
const _cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  _stats.cacheHits++;
  return entry.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }

// ── Serialized FB request queue ─────────────────────────────────────────────
// All FB API page fetches run through this queue one at a time with a gap
// between calls. This prevents simultaneous multi-account bursts from tripping
// the per-user rate limit.
const FB_CALL_GAP_MS = 250; // ms between consecutive FB API calls
const _fbQueue = [];
let   _fbRunning = false;

function fbFetch(url) {
  return new Promise((resolve, reject) => {
    _fbQueue.push({ url, resolve, reject });
    _drainFbQueue();
  });
}

async function _drainFbQueue() {
  if (_fbRunning) return;
  _fbRunning = true;
  while (_fbQueue.length > 0) {
    const { url, resolve, reject } = _fbQueue.shift();
    try { resolve(await fetch(url)); } catch (e) { reject(e); }
    if (_fbQueue.length > 0) await new Promise(r => setTimeout(r, FB_CALL_GAP_MS));
  }
  _fbRunning = false;
}

// ── API usage stats tracker ──────────────────────────────────────────────────
const _stats = {
  callCount: 0,     // total real FB API calls (not cache hits)
  cacheHits: 0,     // served from cache
  errors: 0,        // failed calls
  accountErrors: {}, // account → last error message
  rateLimits: {},   // account → { call_count, total_time, total_cputime } (percentages 0–100)
  recentCalls: [],  // last 100 calls
  sessionStart: Date.now(),
};

function recordCall(account, path, pages) {
  _stats.callCount++;
  const entry = { ts: Date.now(), account, path, pages };
  _stats.recentCalls.unshift(entry);
  if (_stats.recentCalls.length > 100) _stats.recentCalls.length = 100;
}

function captureRateLimit(account, headers) {
  try {
    const appUsage = headers.get('x-app-usage');
    if (appUsage) {
      const parsed = JSON.parse(appUsage);
      _stats.rateLimits[account] = { ...(_stats.rateLimits[account] || {}), ...parsed };
    }
    const acctUsage = headers.get('x-ad-account-usage');
    if (acctUsage) {
      const parsed = JSON.parse(acctUsage);
      _stats.rateLimits[account] = { ...(_stats.rateLimits[account] || {}), acc_id_util_pct: parsed.acc_id_util_pct };
    }
    const bizUsage = headers.get('x-business-use-case-usage');
    if (bizUsage) {
      const parsed = JSON.parse(bizUsage);
      const first = Object.values(parsed)[0]?.[0];
      if (first) _stats.rateLimits[account] = { ...(_stats.rateLimits[account] || {}), biz_call_count: first.call_count, biz_total_cputime: first.total_cputime, biz_total_time: first.total_time };
    }
  } catch { /* ignore malformed headers */ }
}

const INSIGHTS_FIELDS = [
  'spend',
  'impressions',
  'reach',
  'clicks',
  'unique_inline_link_clicks',
  'cpm',
  'ctr',
  'unique_ctr',
  'frequency',
  'cost_per_unique_inline_link_click',
  'cost_per_result',
  'actions',
  'video_avg_time_watched_actions',
  'video_play_actions',
].join(',');

// Extract lead/result count from the actions array.
// Facebook returns actions as [{ action_type, value }, ...].
// For law firm lead gen campaigns the relevant types are checked in priority order.
function extractResults(insightRow) {
  const actions = insightRow.actions || [];

  const leadTypes = [
    'offsite_conversion.fb_pixel_lead', // pixel-only — excludes CAPI/server events
    'onsite_conversion.lead_grouped',   // lead form submissions
    'contact',
    'schedule',
    'submit_application',
    // NOTE: 'lead' intentionally excluded — it aggregates CAPI + pixel and inflates counts when CAPI dupes occur
  ];

  for (const type of leadTypes) {
    const action = actions.find(a => a.action_type === type);
    if (action) return { results: parseInt(action.value, 10) || 0, resultType: 'Leads' };
  }

  // Broad fallback: any lead-related type EXCEPT 'lead' (which includes CAPI)
  const broadLead = actions.find(a => a.action_type !== 'lead' && a.action_type.includes('lead'));
  if (broadLead) return { results: parseInt(broadLead.value, 10) || 0, resultType: 'Leads' };

  // Fall back to computing from spend ÷ cost_per_result if available
  const cprStr = parseCpr(insightRow.cost_per_result);
  const cpr = parseFloat(cprStr);
  const spend = parseFloat(insightRow.spend);
  if (cpr > 0 && spend > 0) {
    return { results: Math.round(spend / cpr), resultType: 'Results' };
  }

  return { results: 0, resultType: 'Leads' };
}

// Compute CPL from spend ÷ leads when FB doesn't return cost_per_result
// cost_per_result from FB can be a scalar string OR an array [{indicator, values:[{value}]}]
function parseCpr(raw) {
  if (!raw) return null;
  if (!Array.isArray(raw)) {
    const v = parseFloat(raw);
    return (!isNaN(v) && v > 0) ? raw : null;
  }
  if (raw.length > 0) {
    const v = parseFloat(raw[0]?.values?.[0]?.value ?? raw[0]?.value);
    return (!isNaN(v) && v > 0) ? v.toFixed(2) : null;
  }
  return null;
}

function computedCpl(ins, extracted) {
  const fromFb = parseCpr(ins.cost_per_result);
  if (fromFb) return fromFb;
  const spend = parseFloat(ins.spend);
  if (extracted.results > 0 && spend > 0) return (spend / extracted.results).toFixed(2);
  return null;
}

function computedCpc(ins) {
  if (ins.cost_per_unique_inline_link_click) return ins.cost_per_unique_inline_link_click;
  const spend = parseFloat(ins.spend);
  const clicks = parseFloat(ins.unique_inline_link_clicks);
  if (clicks > 0 && spend > 0) return (spend / clicks).toFixed(2);
  return null;
}

function token() {
  return process.env.FB_ACCESS_TOKEN;
}

// Support multiple ad accounts: FB_AD_ACCOUNTS=act_111,act_222 (act_ prefix optional)
function adAccounts() {
  return (process.env.FB_AD_ACCOUNTS || '')
    .split(',')
    .map(a => {
      const id = a.trim();
      return id.startsWith('act_') ? id : `act_${id}`;
    })
    .filter(id => id !== 'act_');
}

// Fetch insights for one account
async function fetchInsightsForAccount(account, level, datePreset, filters = {}, timeRange = null) {
  const params = new URLSearchParams({
    level,
    fields: `${level}_id,${level}_name,${INSIGHTS_FIELDS}`,
    access_token: token(),
    limit: 500,
  });

  if (timeRange) {
    params.set('time_range', JSON.stringify(timeRange));
  } else {
    params.set('date_preset', datePreset || 'last_30d');
  }

  if (filters.campaign_id) params.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: filters.campaign_id }]));
  if (filters.adset_id) params.set('filtering', JSON.stringify([{ field: 'adset.id', operator: 'EQUAL', value: filters.adset_id }]));

  const all = [];
  let url = `${FB_API}/${account}/insights?${params}`;
  let pages = 0;
  while (url) {
    const res = await fbFetch(url);
    pages++;
    captureRateLimit(account, res.headers);
    const json = await res.json();
    if (json.error) { _stats.errors++; throw new Error(`[${account}] ${json.error.message}`); }
    all.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  recordCall(account, 'insights', pages);
  return all;
}

// Fetch insights from all accounts and merge — skips accounts that error (raw, no blacklist)
async function fetchInsightsRaw(level, datePreset, filters = {}, timeRange = null) {
  const accounts = adAccounts();
  const settled = await Promise.allSettled(accounts.map(a => fetchInsightsForAccount(a, level, datePreset, filters, timeRange)));
  return settled.flatMap((r, i) => {
    if (r.status === 'rejected') {
      const msg = r.reason?.message || 'unknown error';
      const acct = accounts[i];
      console.warn('FB insights skipped account:', msg);
      _stats.accountErrors[acct] = msg;
      return [];
    }
    return r.value;
  });
}

// Fetch insights with automatic blacklist date exclusion.
// Fetches the full range once, then subtracts cached per-entity deductions for blacklisted dates.
// Pass full=true to bypass blacklist (spend tracker).
async function fetchInsights(level, datePreset, filters = {}, timeRange = null, full = false) {
  if (full) return fetchInsightsRaw(level, datePreset, filters, timeRange);

  // Check if the effective range overlaps any blacklisted date
  const checkRange = timeRange || presetToRange(datePreset || 'last_30d');
  if (!rangeContainsBlacklist(checkRange.since, checkRange.until)) {
    return fetchInsightsRaw(level, datePreset, filters, timeRange);
  }

  // Fetch full range + cached deductions in parallel, then subtract
  const [rows, deductions] = await Promise.all([
    fetchInsightsRaw(level, datePreset, filters, timeRange),
    getBlacklistDeductions(level, filters),
  ]);
  return applyBlacklistDeductions(rows, deductions);
}

// Fetch a list endpoint (campaigns/adsets/ads) from all accounts and merge — skips accounts that error
async function fetchFromAllAccounts(path, queryParams) {
  const accounts = adAccounts();
  const settled = await Promise.allSettled(accounts.map(async account => {
    const all = [];
    let url = `${FB_API}/${account}/${path}?${new URLSearchParams({ ...queryParams, access_token: token(), limit: 500 })}`;
    let pages = 0;
    while (url) {
      const res = await fbFetch(url);
      pages++;
      captureRateLimit(account, res.headers);
      const json = await res.json();
      if (json.error) { _stats.errors++; throw new Error(`[${account}] ${json.error.message}`); }
      all.push(...(json.data || []));
      url = json.paging?.next || null;
    }
    recordCall(account, path, pages);
    return all;
  }));
  return settled.flatMap((r, i) => {
    if (r.status === 'rejected') {
      const msg = r.reason?.message || 'unknown error';
      const acct = accounts[i];
      console.warn('FB list skipped account:', msg);
      _stats.accountErrors[acct] = msg;
      return [];
    }
    return r.value;
  });
}

// GET /api/facebook/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const { date_preset, start, end } = req.query;
    const cacheKey = `campaigns:${date_preset||''}:${start||''}:${end||''}`;
    const cached = req.query.force ? null : cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const timeRange = start && end ? { since: start, until: end } : null;

    const [campaigns, insights] = await Promise.all([
      fetchFromAllAccounts('campaigns', {
        fields: 'id,name,status,effective_status,objective,created_time,daily_budget,lifetime_budget',
      }),
      fetchInsights('campaign', date_preset, {}, timeRange),
    ]);

    const insightsMap = Object.fromEntries(insights.map(i => [i.campaign_id, i]));

    // Deduplicate campaigns by id (same campaign may appear from multiple accounts)
    const seenCampaigns = new Set();
    const uniqueCampaigns = campaigns.filter(c => { if (seenCampaigns.has(c.id)) return false; seenCampaigns.add(c.id); return true; });

    const merged = uniqueCampaigns.map(c => {
      const ins = insightsMap[c.id] || {};
      const ext = extractResults(ins);
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        effectiveStatus: c.effective_status,
        objective: c.objective,
        createdTime: c.created_time,
        dailyBudget: c.daily_budget,
        lifetimeBudget: c.lifetime_budget,
        ...ins,
        ...ext,
        cost_per_result: computedCpl(ins, ext),
        unique_clicks: ins.unique_inline_link_clicks,
        cost_per_unique_click: computedCpc(ins),
      };
    });

    cacheSet(cacheKey, merged);
    res.json(merged);
  } catch (err) {
    console.error('FB campaigns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/campaign-insights?campaign_id=xxx
// Returns lifetime (all-time) insights for a single campaign — used to seed default KPIs.
router.get('/campaign-insights', async (req, res) => {
  try {
    const { campaign_id } = req.query;
    if (!campaign_id) return res.status(400).json({ error: 'campaign_id required' });
    const insights = await fetchInsights('campaign', 'maximum', { campaign_id });
    const ins = insights.find(i => i.campaign_id === campaign_id) || {};
    res.json({ ...ins, ...extractResults(ins) });
  } catch (err) {
    console.error('FB campaign-insights error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/adsets?campaign_id=
router.get('/adsets', async (req, res) => {
  try {
    const { date_preset, campaign_id, start, end } = req.query;
    const cacheKey = `adsets:${campaign_id||''}:${date_preset||''}:${start||''}:${end||''}`;
    const cached = req.query.force ? null : cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const timeRange = start && end ? { since: start, until: end } : null;

    const listParams = { fields: 'id,name,status,effective_status,campaign_id,campaign{name,daily_budget,lifetime_budget},created_time,daily_budget,lifetime_budget,optimization_goal' };
    if (campaign_id) listParams.filtering = JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: campaign_id }]);

    const [adsets, insights] = await Promise.all([
      fetchFromAllAccounts('adsets', listParams),
      fetchInsights('adset', date_preset, campaign_id ? { campaign_id } : {}, timeRange),
    ]);

    const insightsMap = Object.fromEntries(insights.map(i => [i.adset_id, i]));

    // Deduplicate adsets by id
    const seenAdsets = new Set();
    const uniqueAdsets = adsets.filter(a => { if (seenAdsets.has(a.id)) return false; seenAdsets.add(a.id); return true; });

    const merged = uniqueAdsets.map(a => {
      const ins = insightsMap[a.id] || {};
      const ext = extractResults(ins);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        campaignId: a.campaign_id,
        campaignName: a.campaign?.name || '',
        createdTime: a.created_time,
        dailyBudget: a.daily_budget,
        lifetimeBudget: a.lifetime_budget,
        campaignDailyBudget: a.campaign?.daily_budget,
        campaignLifetimeBudget: a.campaign?.lifetime_budget,
        optimizationGoal: a.optimization_goal,
        effectiveStatus: a.effective_status,
        ...ins,
        ...ext,
        cost_per_result: computedCpl(ins, ext),
        unique_clicks: ins.unique_inline_link_clicks,
        cost_per_unique_click: computedCpc(ins),
      };
    });

    cacheSet(cacheKey, merged);
    res.json(merged);
  } catch (err) {
    console.error('FB adsets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/ads?adset_id=&date_preset=&start=YYYY-MM-DD&end=YYYY-MM-DD
router.get('/ads', async (req, res) => {
  try {
    const { date_preset, adset_id, start, end } = req.query;
    const cacheKey = `ads:${date_preset}:${adset_id||''}:${start||''}:${end||''}`;
    const cached = req.query.force ? null : cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Fast path: metadata only (no insights)
    if (req.query.metadata_only === 'true') {
      const cacheKey = 'ads:metadata';
      const cached = cacheGet(cacheKey);
      if (cached) return res.json(cached);
      const listParams = { fields: 'id,name,status,effective_status,adset_id,adset{name,status,effective_status},campaign_id,campaign{name},creative{id,name,thumbnail_url},created_time,daily_budget,lifetime_budget' };
      const ads = await fetchFromAllAccounts('ads', listParams);
      const mapped = ads.map(a => ({
        id: a.id, name: a.name, status: a.status, effectiveStatus: a.effective_status,
        adsetId: a.adset_id, adsetName: a.adset?.name || '',
        adsetStatus: a.adset?.effective_status || a.adset?.status || '',
        campaignId: a.campaign_id, campaignName: a.campaign?.name || '',
        creative: a.creative, createdTime: a.created_time,
        daily_budget: a.daily_budget, lifetime_budget: a.lifetime_budget,
      }));
      cacheSet(cacheKey, mapped);
      return res.json(mapped);
    }

    const timeRange = start && end ? { since: start, until: end } : null;
    const listParams = { fields: 'id,name,status,effective_status,adset_id,adset{name,status,effective_status},campaign_id,campaign{name},creative{id,name,thumbnail_url},created_time' };
    if (adset_id) listParams.filtering = JSON.stringify([{ field: 'adset.id', operator: 'EQUAL', value: adset_id }]);

    const [ads, insights] = await Promise.all([
      fetchFromAllAccounts('ads', listParams),
      fetchInsights('ad', date_preset, adset_id ? { adset_id } : {}, timeRange),
    ]);

    const insightsMap = Object.fromEntries(insights.map(i => [i.ad_id, i]));

    // Deduplicate ads by id
    const seenAds = new Set();
    const uniqueAds = ads.filter(a => { if (seenAds.has(a.id)) return false; seenAds.add(a.id); return true; });

    const merged = uniqueAds.map(a => {
      const ins = insightsMap[a.id] || {};
      const ext = extractResults(ins);
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        effectiveStatus: a.effective_status,
        adsetId: a.adset_id,
        adsetName: a.adset?.name || '',
        adsetStatus: a.adset?.effective_status || a.adset?.status || '',
        campaignId: a.campaign_id,
        campaignName: a.campaign?.name || '',
        creative: a.creative,
        createdTime: a.created_time,
        ...ins,
        ...ext,
        cost_per_result: computedCpl(ins, ext),
        unique_clicks: ins.unique_inline_link_clicks,
        cost_per_unique_click: computedCpc(ins),
      };
    });

    // Don't cache if insights appear rate-limited (ads have spend but no results)
    const hasSpend   = merged.some(a => parseFloat(a.spend)   > 0);
    const hasResults = merged.some(a => (a.results || 0)       > 0);
    if (!hasSpend || hasResults) cacheSet(cacheKey, merged);

    res.json(merged);
  } catch (err) {
    console.error('FB ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shared daily-insights fetcher (used by /daily endpoint + prefetch) ───────
async function fetchDailyInsights({ level, datePreset, start, end, date, adIdList, adsetIdList, full }) {
  const fields = level === 'ad'
    ? `ad_id,ad_name,campaign_name,spend,impressions,unique_inline_link_clicks,cpm,actions,date_start,date_stop`
    : level === 'adset'
    ? `adset_id,adset_name,campaign_name,spend,impressions,unique_inline_link_clicks,cpm,actions,date_start,date_stop`
    : `campaign_id,campaign_name,spend,impressions,cpm,actions,date_start,date_stop`;

  const accounts = adAccounts();
  const all = [];
  const settled = await Promise.allSettled(accounts.map(async account => {
    const params = new URLSearchParams({ level, fields, time_increment: 1, access_token: token(), limit: 500 });
    if (start && end)   params.set('time_range', JSON.stringify({ since: start, until: end }));
    else if (date)      params.set('time_range', JSON.stringify({ since: date, until: date }));
    else                params.set('date_preset', datePreset || 'last_30d');
    if (adIdList?.length)    params.set('filtering', JSON.stringify([{ field: 'ad.id',    operator: 'IN', value: adIdList }]));
    else if (adsetIdList?.length) params.set('filtering', JSON.stringify([{ field: 'adset.id', operator: 'IN', value: adsetIdList }]));

    let url = `${FB_API}/${account}/insights?${params}`;
    let pages = 0;
    while (url) {
      const r = await fbFetch(url);
      pages++;
      captureRateLimit(account, r.headers);
      const json = await r.json();
      if (json.error) { _stats.errors++; throw new Error(`[${account}] ${json.error.message}`); }
      all.push(...(json.data || []));
      url = json.paging?.next || null;
    }
    recordCall(account, `daily/${level}`, pages);
  }));
  settled.forEach(r => { if (r.status === 'rejected') console.warn('FB daily skipped account:', r.reason?.message); });

  const idKey = level === 'ad' ? 'ad_id' : level === 'adset' ? 'adset_id' : 'campaign_id';
  const deduped = [...new Map(all.map(r => [`${r[idKey]}:${r.date_start}`, r])).values()];
  const isSpendTracker = level === 'campaign' && start && end && !adIdList && !adsetIdList;
  return (full || isSpendTracker) ? deduped : deduped.filter(r => !BLACKLIST_DATES.has(r.date_start));
}

// GET /api/facebook/daily?date_preset=&level=campaign&ad_ids=id1,id2&date=YYYY-MM-DD
router.get('/daily', async (req, res) => {
  try {
    const { date_preset, ad_ids, adset_ids, date, start, end } = req.query;
    const adIdList    = ad_ids    ? ad_ids.split(',').filter(Boolean)    : null;
    const adsetIdList = adset_ids ? adset_ids.split(',').filter(Boolean) : null;
    const level = (adIdList?.length || date) ? 'ad'
                : adsetIdList?.length         ? 'adset'
                : (req.query.level || 'campaign');
    const full = req.query.full === 'true';
    const cacheKey = `daily:${level}:${date_preset||''}:${ad_ids||''}:${adset_ids||''}:${date||''}:${start||''}:${end||''}:${full}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const result = await fetchDailyInsights({ level, datePreset: date_preset, start, end, date, adIdList, adsetIdList, full });
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('FB daily error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/ad/:id/preview — opens an HTML page with the FB ad preview iframe
router.get('/ad/:id/preview', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await fetch(
      `${FB_API}/${id}/previews?ad_format=MOBILE_FEED_STANDARD&access_token=${token()}`
    );
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    const iframeBody = json.data?.[0]?.body;
    if (!iframeBody) throw new Error('No preview available for this ad');
    res.send(`<!DOCTYPE html><html><head><title>Ad Preview</title>
<style>body{margin:0;display:flex;justify-content:center;align-items:flex-start;padding:32px;background:#f0f2f5;min-height:100vh;box-sizing:border-box;}
</style></head><body>${iframeBody}</body></html>`);
  } catch (err) {
    res.status(500).send(`<h3 style="font-family:sans-serif;color:#dc2626;padding:32px">Preview unavailable: ${err.message}</h3>`);
  }
});

// GET /api/facebook/campaign-spend?since=YYYY-MM-DD&until=YYYY-MM-DD
// Returns total spend per campaign for a custom date range (for pacing calculations)
router.get('/campaign-spend', async (req, res) => {
  try {
    const { since, until } = req.query;
    if (!since || !until) return res.status(400).json({ error: 'since and until required' });
    const cacheKey = `campaign-spend:${since}:${until}`;
    const cached = req.query.force ? null : cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Spend tracker always gets full accurate data — blacklist bypass intentional
    const insights = await fetchInsights('campaign', null, {}, { since, until }, true);
    const result = insights.map(i => ({
      campaign_id: i.campaign_id,
      campaign_name: i.campaign_name,
      spend: parseFloat(i.spend) || 0,
    }));

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('FB campaign-spend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Hourly pre-fetch ─────────────────────────────────────────────────────────
// Populates the cache for all common queries once per hour so that every
// client request is served instantly without hitting the Meta API.
const PREFETCH_PRESETS = ['maximum'];

const _prefetch = { running: false, lastRun: null, lastSuccess: null, lastError: null, durationMs: null };

async function runPrefetch() {
  if (_prefetch.running) { console.log('[prefetch] already running, skipping'); return; }
  _prefetch.running = true;
  _prefetch.lastRun = Date.now();
  const t0 = Date.now();
  console.log('[prefetch] starting…');

  try {
    const today = new Date().toISOString().slice(0, 10);
    const now   = new Date();
    const curY  = now.getFullYear();
    const curM  = now.getMonth() + 1;
    const curMonthStart = `${curY}-${String(curM).padStart(2,'0')}-01`;
    const curMonthEnd   = `${curY}-${String(curM).padStart(2,'0')}-${String(new Date(curY, curM, 0).getDate()).padStart(2,'0')}`;
    const prevDate = new Date(curY, curM - 2, 1);
    const prevY = prevDate.getFullYear(), prevM = prevDate.getMonth() + 1;
    const prevMonthStart = `${prevY}-${String(prevM).padStart(2,'0')}-01`;
    const prevMonthEnd   = `${prevY}-${String(prevM).padStart(2,'0')}-${String(new Date(prevY, prevM, 0).getDate()).padStart(2,'0')}`;

    // ── 1. Fetch entity lists once (shared across all preset insight calls) ──
    const [campaignList, adsetList, adList] = await Promise.all([
      fetchFromAllAccounts('campaigns', {
        fields: 'id,name,status,effective_status,objective,created_time,daily_budget,lifetime_budget',
      }),
      fetchFromAllAccounts('adsets', {
        fields: 'id,name,status,effective_status,campaign_id,campaign{name,daily_budget,lifetime_budget},created_time,daily_budget,lifetime_budget,optimization_goal',
      }),
      fetchFromAllAccounts('ads', {
        fields: 'id,name,status,effective_status,adset_id,adset{name,status,effective_status},campaign_id,campaign{name},creative{id,name,thumbnail_url},created_time,daily_budget,lifetime_budget',
      }),
    ]);

    // Deduplicate entity lists
    const dedup = (list, key = 'id') => [...new Map(list.map(x => [x[key], x])).values()];
    const campaigns = dedup(campaignList);
    const adsets    = dedup(adsetList);
    const ads       = dedup(adList);

    // Cache ad metadata immediately (no insights needed)
    {
      const mapped = ads.map(a => ({
        id: a.id, name: a.name, status: a.status, effectiveStatus: a.effective_status,
        adsetId: a.adset_id, adsetName: a.adset?.name || '',
        adsetStatus: a.adset?.effective_status || a.adset?.status || '',
        campaignId: a.campaign_id, campaignName: a.campaign?.name || '',
        creative: a.creative, createdTime: a.created_time,
        daily_budget: a.daily_budget, lifetime_budget: a.lifetime_budget,
      }));
      cacheSet('ads:metadata', mapped);
    }

    // ── 2. Campaign + adset + ad insights for each preset (sequential) ──────
    for (const preset of PREFETCH_PRESETS) {
      // Campaigns
      const campInsights = await fetchInsights('campaign', preset, {}, null);
      const campMap = Object.fromEntries(campInsights.map(i => [i.campaign_id, i]));
      const campMerged = campaigns.map(c => {
        const ins = campMap[c.id] || {};
        const ext = extractResults(ins);
        return {
          id: c.id, name: c.name, status: c.status, effectiveStatus: c.effective_status,
          objective: c.objective, createdTime: c.created_time,
          dailyBudget: c.daily_budget, lifetimeBudget: c.lifetime_budget,
          ...ins, ...ext,
          cost_per_result: computedCpl(ins, ext),
          unique_clicks: ins.unique_inline_link_clicks,
          cost_per_unique_click: computedCpc(ins),
        };
      });
      cacheSet(`campaigns:${preset}::`, campMerged);

      // Adsets
      const adsetInsights = await fetchInsights('adset', preset, {}, null);
      const adsetMap = Object.fromEntries(adsetInsights.map(i => [i.adset_id, i]));
      const adsetMerged = adsets.map(a => {
        const ins = adsetMap[a.id] || {};
        const ext = extractResults(ins);
        return {
          id: a.id, name: a.name, status: a.status, campaignId: a.campaign_id,
          campaignName: a.campaign?.name || '', createdTime: a.created_time,
          dailyBudget: a.daily_budget, lifetimeBudget: a.lifetime_budget,
          campaignDailyBudget: a.campaign?.daily_budget, campaignLifetimeBudget: a.campaign?.lifetime_budget,
          optimizationGoal: a.optimization_goal, effectiveStatus: a.effective_status,
          ...ins, ...ext,
          cost_per_result: computedCpl(ins, ext),
          unique_clicks: ins.unique_inline_link_clicks,
          cost_per_unique_click: computedCpc(ins),
        };
      });
      cacheSet(`adsets::${preset}::`, adsetMerged);

      // Ads with insights
      const adInsights = await fetchInsights('ad', preset, {}, null);
      const adMap = Object.fromEntries(adInsights.map(i => [i.ad_id, i]));
      const adMerged = ads.map(a => {
        const ins = adMap[a.id] || {};
        const ext = extractResults(ins);
        return {
          id: a.id, name: a.name, status: a.status, effectiveStatus: a.effective_status,
          adsetId: a.adset_id, adsetName: a.adset?.name || '',
          adsetStatus: a.adset?.effective_status || a.adset?.status || '',
          campaignId: a.campaign_id, campaignName: a.campaign?.name || '',
          creative: a.creative, createdTime: a.created_time,
          ...ins, ...ext,
          cost_per_result: computedCpl(ins, ext),
          unique_clicks: ins.unique_inline_link_clicks,
          cost_per_unique_click: computedCpc(ins),
        };
      });
      cacheSet(`ads:${preset}:::`, adMerged);

      console.log(`[prefetch] preset ${preset} done`);
    }

    // ── 3. Adsets with no preset (base query used by SpendSheet live budget) ─
    {
      const adsetInsights = await fetchInsights('adset', 'last_30d', {}, null);
      const adsetMap = Object.fromEntries(adsetInsights.map(i => [i.adset_id, i]));
      const merged = adsets.map(a => {
        const ins = adsetMap[a.id] || {};
        const ext = extractResults(ins);
        return {
          id: a.id, name: a.name, status: a.status, campaignId: a.campaign_id,
          campaignName: a.campaign?.name || '', createdTime: a.created_time,
          dailyBudget: a.daily_budget, lifetimeBudget: a.lifetime_budget,
          campaignDailyBudget: a.campaign?.daily_budget, campaignLifetimeBudget: a.campaign?.lifetime_budget,
          optimizationGoal: a.optimization_goal, effectiveStatus: a.effective_status,
          ...ins, ...ext,
          cost_per_result: computedCpl(ins, ext),
          unique_clicks: ins.unique_inline_link_clicks,
          cost_per_unique_click: computedCpc(ins),
        };
      });
      cacheSet('adsets::::',  merged);
    }

    // ── 4. Daily campaign data for SpendSheet (current + previous month) ─────
    const curDaily  = await fetchDailyInsights({ level: 'campaign', start: curMonthStart,  end: curMonthEnd,  full: true });
    cacheSet(`daily:campaign:::::${curMonthStart}:${curMonthEnd}:true`, curDaily);

    const prevDaily = await fetchDailyInsights({ level: 'campaign', start: prevMonthStart, end: prevMonthEnd, full: true });
    cacheSet(`daily:campaign:::::${prevMonthStart}:${prevMonthEnd}:true`, prevDaily);

    // ── 5. Campaign-level spend for current month (pacing) ───────────────────
    const spendInsights = await fetchInsights('campaign', null, {}, { since: curMonthStart, until: today }, true);
    const spendResult = spendInsights.map(i => ({
      campaign_id: i.campaign_id,
      campaign_name: i.campaign_name,
      spend: parseFloat(i.spend) || 0,
    }));
    cacheSet(`campaign-spend:${curMonthStart}:${today}`, spendResult);

    _prefetch.lastSuccess = Date.now();
    _prefetch.lastError   = null;
    _prefetch.durationMs  = Date.now() - t0;
    console.log(`[prefetch] complete in ${(_prefetch.durationMs / 1000).toFixed(1)}s`);
  } catch (err) {
    _prefetch.lastError = err.message;
    console.error('[prefetch] failed:', err.message);
  } finally {
    _prefetch.running = false;
  }
}

// Run 60s after startup (let server warm up), then every hour
setTimeout(runPrefetch, 60_000);
setInterval(runPrefetch, 60 * 60 * 1000);

// POST /api/facebook/prefetch — trigger a manual prefetch immediately
router.post('/prefetch', async (req, res) => {
  if (_prefetch.running) return res.json({ ok: false, message: 'already running' });
  runPrefetch(); // fire-and-forget
  res.json({ ok: true, message: 'prefetch started' });
});

// GET /api/facebook/stats — API usage metrics for this server session
router.get('/stats', (req, res) => {
  const cacheSize = _cache.size;
  const cacheKeys = [..._cache.entries()].map(([key, v]) => ({
    key,
    age: Math.round((Date.now() - v.ts) / 1000),
    expiresIn: Math.round((CACHE_TTL - (Date.now() - v.ts)) / 1000),
  }));
  res.json({
    configuredAccounts: adAccounts(),
    sessionStart: _stats.sessionStart,
    uptimeSeconds: Math.round((Date.now() - _stats.sessionStart) / 1000),
    callCount: _stats.callCount,
    cacheHits: _stats.cacheHits,
    errors: _stats.errors,
    accountErrors: _stats.accountErrors || {},
    rateLimits: _stats.rateLimits,
    queueDepth: _fbQueue.length,
    queueRunning: _fbRunning,
    callGapMs: FB_CALL_GAP_MS,
    cacheSize,
    cacheKeys,
    recentCalls: _stats.recentCalls,
    prefetch: {
      running:     _prefetch.running,
      lastRun:     _prefetch.lastRun,
      lastSuccess: _prefetch.lastSuccess,
      lastError:   _prefetch.lastError,
      durationMs:  _prefetch.durationMs,
      nextRunIn:   _prefetch.lastRun
        ? Math.max(0, Math.round(((_prefetch.lastRun + 60 * 60 * 1000) - Date.now()) / 1000))
        : null,
    },
  });
});

export default router;
