import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();
const FB_API = 'https://graph.facebook.com/v19.0';

// ── Server-side in-memory cache for FB API responses ────────────────────────
// Keyed by request path+params. TTL: 2 hours. Survives across client reloads.
const _cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }); }

const INSIGHTS_FIELDS = [
  'spend',
  'impressions',
  'reach',
  'clicks',
  'unique_clicks',
  'cpm',
  'ctr',
  'unique_ctr',
  'frequency',
  'cost_per_unique_click',
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
    'lead',
    'onsite_conversion.lead_grouped',
    'offsite_conversion.fb_pixel_lead',
    'contact',
    'schedule',
    'submit_application',
  ];

  for (const type of leadTypes) {
    const action = actions.find(a => a.action_type === type);
    if (action) return { results: parseInt(action.value, 10) || 0, resultType: 'Leads' };
  }

  // Broad fallback: any action type containing 'lead'
  const broadLead = actions.find(a => a.action_type.includes('lead'));
  if (broadLead) return { results: parseInt(broadLead.value, 10) || 0, resultType: 'Leads' };

  // Fall back to computing from spend ÷ cost_per_result if available
  const cpr = parseFloat(insightRow.cost_per_result);
  const spend = parseFloat(insightRow.spend);
  if (cpr > 0 && spend > 0) {
    return { results: Math.round(spend / cpr), resultType: 'Results' };
  }

  return { results: 0, resultType: 'Leads' };
}

// Compute CPL from spend ÷ leads when FB doesn't return cost_per_result
function computedCpl(ins, extracted) {
  if (ins.cost_per_result) return ins.cost_per_result;
  const spend = parseFloat(ins.spend);
  if (extracted.results > 0 && spend > 0) return (spend / extracted.results).toFixed(2);
  return null;
}

function computedCpc(ins) {
  if (ins.cost_per_unique_click) return ins.cost_per_unique_click;
  const spend = parseFloat(ins.spend);
  const clicks = parseFloat(ins.unique_clicks);
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
  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    if (json.error) throw new Error(`[${account}] ${json.error.message}`);
    all.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  return all;
}

// Fetch insights from all accounts and merge — skips accounts that error
async function fetchInsights(level, datePreset, filters = {}, timeRange = null) {
  const accounts = adAccounts();
  const settled = await Promise.allSettled(accounts.map(a => fetchInsightsForAccount(a, level, datePreset, filters, timeRange)));
  return settled.flatMap(r => {
    if (r.status === 'rejected') { console.warn('FB insights skipped account:', r.reason?.message); return []; }
    return r.value;
  });
}

// Fetch a list endpoint (campaigns/adsets/ads) from all accounts and merge — skips accounts that error
async function fetchFromAllAccounts(path, queryParams) {
  const accounts = adAccounts();
  const settled = await Promise.allSettled(accounts.map(async account => {
    const all = [];
    let url = `${FB_API}/${account}/${path}?${new URLSearchParams({ ...queryParams, access_token: token(), limit: 500 })}`;
    while (url) {
      const res = await fetch(url);
      const json = await res.json();
      if (json.error) throw new Error(`[${account}] ${json.error.message}`);
      all.push(...(json.data || []));
      url = json.paging?.next || null;
    }
    return all;
  }));
  return settled.flatMap(r => {
    if (r.status === 'rejected') { console.warn('FB list skipped account:', r.reason?.message); return []; }
    return r.value;
  });
}

// GET /api/facebook/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const { date_preset, start, end } = req.query;
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
        cost_per_unique_click: computedCpc(ins),
      };
    });

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
    const timeRange = start && end ? { since: start, until: end } : null;

    const listParams = { fields: 'id,name,status,effective_status,campaign_id,campaign{name},created_time,daily_budget,lifetime_budget,optimization_goal' };
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
        optimizationGoal: a.optimization_goal,
        effectiveStatus: a.effective_status,
        ...ins,
        ...ext,
        cost_per_result: computedCpl(ins, ext),
        cost_per_unique_click: computedCpc(ins),
      };
    });

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
    const cached = cacheGet(cacheKey);
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
        cost_per_unique_click: computedCpc(ins),
      };
    });

    cacheSet(cacheKey, merged);
    res.json(merged);
  } catch (err) {
    console.error('FB ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/daily?date_preset=&level=campaign&ad_ids=id1,id2&date=YYYY-MM-DD
// Returns per-day spend/impressions/CPM/leads — paginates through all cursor pages.
// When ad_ids is provided, filters to those ad IDs (level=ad implied).
// When date=YYYY-MM-DD is provided, fetches a single day (level=ad with actions).
router.get('/daily', async (req, res) => {
  try {
    const { date_preset, ad_ids, date, start, end } = req.query;
    const adIdList = ad_ids ? ad_ids.split(',').filter(Boolean) : null;
    const level = (adIdList?.length || date) ? 'ad' : (req.query.level || 'campaign');
    const cacheKey = `daily:${level}:${date_preset||''}:${ad_ids||''}:${date||''}:${start||''}:${end||''}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);
    const fields = level === 'ad'
      ? `ad_id,ad_name,campaign_name,spend,impressions,unique_clicks,cpm,actions,date_start,date_stop`
      : `campaign_id,campaign_name,spend,impressions,cpm,actions,date_start,date_stop`;

    const accounts = adAccounts();
    const all = [];
    await Promise.allSettled(accounts.map(async account => {
      const params = new URLSearchParams({
        level,
        fields,
        time_increment: 1,
        access_token: token(),
        limit: 500,
      });
      if (start && end) {
        params.set('time_range', JSON.stringify({ since: start, until: end }));
      } else if (date) {
        params.set('time_range', JSON.stringify({ since: date, until: date }));
      } else {
        params.set('date_preset', date_preset || 'last_30d');
      }
      if (adIdList?.length) {
        params.set('filtering', JSON.stringify([{ field: 'ad.id', operator: 'IN', value: adIdList }]));
      }
      let url = `${FB_API}/${account}/insights?${params}`;
      while (url) {
        const r = await fetch(url);
        const json = await r.json();
        if (json.error) throw new Error(`[${account}] ${json.error.message}`);
        all.push(...(json.data || []));
        url = json.paging?.next || null;
      }
    })).then(results => results.forEach(r => {
      if (r.status === 'rejected') console.warn('FB daily skipped account:', r.reason?.message);
    }));
    // Deduplicate by entity_id + date in case same campaign/adset appears from multiple accounts
    const idKey = level === 'ad' ? 'ad_id' : level === 'adset' ? 'adset_id' : 'campaign_id';
    const deduped = [...new Map(all.map(r => [`${r[idKey]}:${r.date_start}`, r])).values()];
    cacheSet(cacheKey, deduped);
    res.json(deduped);
  } catch (err) {
    console.error('FB daily error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/facebook/ad/:id/status  body: { status: 'ACTIVE'|'PAUSED' }
router.post('/ad/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['ACTIVE', 'PAUSED'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const r = await fetch(`${FB_API}/${id}?access_token=${token()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
