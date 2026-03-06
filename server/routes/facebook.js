import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();
const FB_API = 'https://graph.facebook.com/v19.0';

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

  // Fall back to computing from spend ÷ cost_per_result if available
  const cpr = parseFloat(insightRow.cost_per_result);
  const spend = parseFloat(insightRow.spend);
  if (cpr > 0 && spend > 0) {
    return { results: Math.round(spend / cpr), resultType: 'Results' };
  }

  return { results: 0, resultType: 'Leads' };
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
async function fetchInsightsForAccount(account, level, datePreset, filters = {}) {
  const params = new URLSearchParams({
    level,
    fields: `${level}_id,${level}_name,${INSIGHTS_FIELDS}`,
    date_preset: datePreset || 'last_30d',
    access_token: token(),
    limit: 500,
  });

  if (filters.campaign_id) params.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: filters.campaign_id }]));
  if (filters.adset_id) params.set('filtering', JSON.stringify([{ field: 'adset.id', operator: 'EQUAL', value: filters.adset_id }]));

  const res = await fetch(`${FB_API}/${account}/insights?${params}`);
  const json = await res.json();
  if (json.error) throw new Error(`[${account}] ${json.error.message}`);
  return json.data || [];
}

// Fetch insights from all accounts and merge
async function fetchInsights(level, datePreset, filters = {}) {
  const accounts = adAccounts();
  const results = await Promise.all(accounts.map(a => fetchInsightsForAccount(a, level, datePreset, filters)));
  return results.flat();
}

// Fetch a list endpoint (campaigns/adsets/ads) from all accounts and merge
async function fetchFromAllAccounts(path, queryParams) {
  const accounts = adAccounts();
  const results = await Promise.all(accounts.map(async account => {
    const params = new URLSearchParams({ ...queryParams, access_token: token(), limit: 500 });
    const res = await fetch(`${FB_API}/${account}/${path}?${params}`);
    const json = await res.json();
    if (json.error) throw new Error(`[${account}] ${json.error.message}`);
    return json.data || [];
  }));
  return results.flat();
}

// GET /api/facebook/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const { date_preset } = req.query;

    const [campaigns, insights] = await Promise.all([
      fetchFromAllAccounts('campaigns', {
        fields: 'id,name,status,objective,created_time,daily_budget,lifetime_budget',
      }),
      fetchInsights('campaign', date_preset),
    ]);

    const insightsMap = Object.fromEntries(insights.map(i => [i.campaign_id, i]));

    const merged = campaigns.map(c => {
      const ins = insightsMap[c.id] || {};
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        createdTime: c.created_time,
        dailyBudget: c.daily_budget,
        lifetimeBudget: c.lifetime_budget,
        ...ins,
        ...extractResults(ins),
      };
    });

    res.json(merged);
  } catch (err) {
    console.error('FB campaigns error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/adsets?campaign_id=
router.get('/adsets', async (req, res) => {
  try {
    const { date_preset, campaign_id } = req.query;

    const listParams = { fields: 'id,name,status,campaign_id,campaign{name},created_time,daily_budget,lifetime_budget,optimization_goal' };
    if (campaign_id) listParams.campaign_id = campaign_id;

    const [adsets, insights] = await Promise.all([
      fetchFromAllAccounts('adsets', listParams),
      fetchInsights('adset', date_preset, campaign_id ? { campaign_id } : {}),
    ]);

    const insightsMap = Object.fromEntries(insights.map(i => [i.adset_id, i]));

    const merged = adsets.map(a => {
      const ins = insightsMap[a.id] || {};
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
        ...ins,
        ...extractResults(ins),
      };
    });

    res.json(merged);
  } catch (err) {
    console.error('FB adsets error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/ads?adset_id=
router.get('/ads', async (req, res) => {
  try {
    const { date_preset, adset_id } = req.query;

    const listParams = { fields: 'id,name,status,adset_id,adset{name},campaign_id,campaign{name},creative{id,name,thumbnail_url},created_time' };
    if (adset_id) listParams.adset_id = adset_id;

    const [ads, insights] = await Promise.all([
      fetchFromAllAccounts('ads', listParams),
      fetchInsights('ad', date_preset, adset_id ? { adset_id } : {}),
    ]);

    const insightsMap = Object.fromEntries(insights.map(i => [i.ad_id, i]));

    const merged = ads.map(a => {
      const ins = insightsMap[a.id] || {};
      return {
        id: a.id,
        name: a.name,
        status: a.status,
        adsetId: a.adset_id,
        adsetName: a.adset?.name || '',
        campaignId: a.campaign_id,
        campaignName: a.campaign?.name || '',
        creative: a.creative,
        createdTime: a.created_time,
        ...ins,
        ...extractResults(ins),
      };
    });

    res.json(merged);
  } catch (err) {
    console.error('FB ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/daily?date_preset=&level=campaign
// Returns per-day spend/impressions/CPM per campaign (or adset/ad)
router.get('/daily', async (req, res) => {
  try {
    const { date_preset, level = 'campaign' } = req.query;
    const accounts = adAccounts();
    const results = await Promise.all(accounts.map(async account => {
      const params = new URLSearchParams({
        level,
        fields: `${level}_id,${level}_name,spend,impressions,cpm,date_start,date_stop`,
        date_preset: date_preset || 'last_30d',
        time_increment: 1,
        access_token: token(),
        limit: 500,
      });
      const r = await fetch(`${FB_API}/${account}/insights?${params}`);
      const json = await r.json();
      if (json.error) throw new Error(`[${account}] ${json.error.message}`);
      return json.data || [];
    }));
    res.json(results.flat());
  } catch (err) {
    console.error('FB daily error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
