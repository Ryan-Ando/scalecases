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
  'video_avg_time_watched_actions',
  'video_play_actions',
].join(',');

function token() {
  return process.env.FB_ACCESS_TOKEN;
}

function adAccount() {
  return process.env.FB_AD_ACCOUNT;
}

// Fetch account-level insights grouped by a given level (campaign/adset/ad)
async function fetchInsights(level, datePreset, filters = {}) {
  const params = new URLSearchParams({
    level,
    fields: `${level}_id,${level}_name,${INSIGHTS_FIELDS}`,
    date_preset: datePreset || 'last_30d',
    access_token: token(),
    limit: 500,
  });

  if (filters.campaign_id) params.set('filtering', JSON.stringify([{ field: 'campaign.id', operator: 'EQUAL', value: filters.campaign_id }]));
  if (filters.adset_id) params.set('filtering', JSON.stringify([{ field: 'adset.id', operator: 'EQUAL', value: filters.adset_id }]));

  const res = await fetch(`${FB_API}/${adAccount()}/insights?${params}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.data || [];
}

// GET /api/facebook/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const { date_preset } = req.query;

    // Fetch campaign list
    const campaignParams = new URLSearchParams({
      fields: 'id,name,status,objective,created_time,daily_budget,lifetime_budget',
      access_token: token(),
      limit: 500,
    });
    const campaignRes = await fetch(`${FB_API}/${adAccount()}/campaigns?${campaignParams}`);
    const campaignJson = await campaignRes.json();
    if (campaignJson.error) throw new Error(campaignJson.error.message);
    const campaigns = campaignJson.data || [];

    // Fetch insights
    const insights = await fetchInsights('campaign', date_preset);
    const insightsMap = Object.fromEntries(insights.map(i => [i.campaign_id, i]));

    const merged = campaigns.map(c => ({
      id: c.id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      createdTime: c.created_time,
      dailyBudget: c.daily_budget,
      lifetimeBudget: c.lifetime_budget,
      ...(insightsMap[c.id] || {}),
    }));

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

    const params = new URLSearchParams({
      fields: 'id,name,status,campaign_id,targeting,created_time,daily_budget,lifetime_budget,optimization_goal',
      access_token: token(),
      limit: 500,
    });
    if (campaign_id) params.set('campaign_id', campaign_id);

    const adsetRes = await fetch(`${FB_API}/${adAccount()}/adsets?${params}`);
    const adsetJson = await adsetRes.json();
    if (adsetJson.error) throw new Error(adsetJson.error.message);
    const adsets = adsetJson.data || [];

    const insights = await fetchInsights('adset', date_preset, campaign_id ? { campaign_id } : {});
    const insightsMap = Object.fromEntries(insights.map(i => [i.adset_id, i]));

    const merged = adsets.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      campaignId: a.campaign_id,
      createdTime: a.created_time,
      dailyBudget: a.daily_budget,
      lifetimeBudget: a.lifetime_budget,
      optimizationGoal: a.optimization_goal,
      ...(insightsMap[a.id] || {}),
    }));

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

    const params = new URLSearchParams({
      fields: 'id,name,status,adset_id,campaign_id,creative{id,name,thumbnail_url},created_time',
      access_token: token(),
      limit: 500,
    });
    if (adset_id) params.set('adset_id', adset_id);

    const adRes = await fetch(`${FB_API}/${adAccount()}/ads?${params}`);
    const adJson = await adRes.json();
    if (adJson.error) throw new Error(adJson.error.message);
    const ads = adJson.data || [];

    const insights = await fetchInsights('ad', date_preset, adset_id ? { adset_id } : {});
    const insightsMap = Object.fromEntries(insights.map(i => [i.ad_id, i]));

    const merged = ads.map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      adsetId: a.adset_id,
      campaignId: a.campaign_id,
      creative: a.creative,
      createdTime: a.created_time,
      ...(insightsMap[a.id] || {}),
    }));

    res.json(merged);
  } catch (err) {
    console.error('FB ads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
