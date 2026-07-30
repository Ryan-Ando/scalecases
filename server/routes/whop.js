// ── Whop Ads spend integration ───────────────────────────────────────────────
// Whop runs campaigns through its own Meta agency ad account, so that spend is
// invisible to our FB tokens. Whop's Ad Reports API fills the gap: one call
// returns per-campaign daily spend, which gets merged into the same routes the
// Spend Sheet already reads (/api/facebook/daily, /api/facebook/campaign-spend)
// and into the Google Sheet push. Campaign names must follow the same
// "<brand?> ... <STATE>" naming convention as Meta campaigns — grouping and the
// LSS-only sheet filter key off the name exactly like FB rows.
// Requires WHOP_API_KEY (Account API key with ad_campaign:stats:read) and
// WHOP_COMPANY_ID (biz_xxx). Absent config → everything returns [].

import fetch from 'node-fetch';

const WHOP_API = process.env.WHOP_API_BASE || 'https://api.whop.com/api/v1';

export function whopEnabled() {
  return !!(process.env.WHOP_API_KEY && process.env.WHOP_COMPANY_ID);
}

async function whopReport(params) {
  const qs = new URLSearchParams({ company_id: process.env.WHOP_COMPANY_ID, ...params });
  const r = await fetch(`${WHOP_API}/ad_reports?${qs}`, {
    headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}` },
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Whop ad_reports HTTP ${r.status}: ${(json && (json.error?.message || json.message)) || 'unknown error'}`);
  return json || {};
}

// Daily per-campaign spend rows in the same shape as FB daily campaign
// insights, so extractGroup/extractBrand/extractState work unchanged.
// Whop failures must never break the FB payload — callers get [] and a warn.
export async function whopDailyCampaignRows(start, end) {
  if (!whopEnabled() || !start || !end) return [];
  try {
    const report = await whopReport({
      from: `${start}T00:00:00.000Z`,
      to: `${end}T23:59:59.999Z`,
      granularity: 'daily',
      breakdown: 'campaign',
    });
    const rows = [];
    for (const c of report.breakdown || []) {
      for (const b of c.granularity || []) {
        const date = (b.stat_date || b.bucket_start || '').slice(0, 10);
        const spend = parseFloat(b.spend) || 0;
        if (!date || !spend) continue;
        rows.push({
          campaign_id: `whop:${c.id}`,
          campaign_name: c.name || '',
          date_start: date,
          date_stop: date,
          spend: String(spend),
          impressions: String(b.impressions ?? 0),
          account: 'whop',
        });
      }
    }
    return rows;
  } catch (e) {
    console.warn('[whop] daily spend fetch failed (serving FB-only):', e.message);
    return [];
  }
}

// Cursor-paginated list fetch for the beta Ads endpoints (/ad_campaigns,
// /ad_groups). `repeat` params (arrays) are appended once per value.
async function whopList(path, params = {}) {
  const out = [];
  let after = null;
  do {
    const qs = new URLSearchParams();
    qs.set('first', '100');
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach(x => qs.append(k, x));
      else if (v != null) qs.set(k, v);
    }
    if (after) qs.set('after', after);
    const r = await fetch(`${WHOP_API}/${path}?${qs}`, {
      headers: { Authorization: `Bearer ${process.env.WHOP_API_KEY}` },
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Whop ${path} HTTP ${r.status}: ${(json && (json.error?.message || json.message)) || 'unknown error'}`);
    out.push(...(json?.data || []));
    after = json?.page_info?.has_next_page ? json.page_info.end_cursor : null;
  } while (after);
  return out;
}

// Synthetic "adset" rows for the Live Daily Budget cards, from REAL Whop
// budgets: campaign-level budget_amount for CBO campaigns
// (budget_optimization === 'ad_campaign'), ad-group budgets for ABO
// (budget_optimization === 'ad_group', where the campaign's budget_amount is
// null). Only active + daily budgets count, matching how the FB cards work.
// Shape matches /adsets?metadata_only=true rows (dailyBudget in cents).
// Requires the ad_campaign:basic:read permission on the API key.
export async function whopLiveBudgetAdsets() {
  if (!whopEnabled()) return [];
  try {
    const campaigns = await whopList('ad_campaigns', { status: 'active' });
    const mkRow = (id, name, campaignId, campaignTitle, dollars) => ({
      id: `whop:${id}`,
      name: `${name || ''} (Whop)`,
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      campaignId: `whop:${campaignId}`,
      campaignName: campaignTitle || '',
      createdTime: null,
      dailyBudget: String(Math.round(dollars * 100)),
      lifetimeBudget: null,
      campaignDailyBudget: null,
      campaignLifetimeBudget: null,
      optimizationGoal: 'whop',
    });

    const rows = [];
    const aboCampaigns = [];
    for (const c of campaigns) {
      if (c.budget_optimization === 'ad_group') { aboCampaigns.push(c); continue; }
      const amount = parseFloat(c.budget_amount) || 0;
      if (c.budget_type === 'daily' && amount > 0) rows.push(mkRow(c.id, c.title, c.id, c.title, amount));
    }
    if (aboCampaigns.length) {
      const titleById = Object.fromEntries(aboCampaigns.map(c => [c.id, c.title]));
      const groups = await whopList('ad_groups', { ad_campaign_ids: aboCampaigns.map(c => c.id) });
      for (const g of groups) {
        const campId = g.ad_campaign_id || g.campaign_id;
        const amount = parseFloat(g.budget_amount) || 0;
        if (g.status === 'active' && g.budget_type === 'daily' && amount > 0 && titleById[campId] != null) {
          rows.push(mkRow(g.id, g.title || g.name, campId, titleById[campId], amount));
        }
      }
    }
    return rows;
  } catch (e) {
    console.warn('[whop] live budget fetch failed (serving FB-only):', e.message);
    return [];
  }
}

// Per-campaign spend totals for a range — same shape as /campaign-spend rows.
export async function whopCampaignSpend(since, until) {
  if (!whopEnabled() || !since || !until) return [];
  try {
    const report = await whopReport({
      from: `${since}T00:00:00.000Z`,
      to: `${until}T23:59:59.999Z`,
      breakdown: 'campaign',
    });
    return (report.breakdown || [])
      .map(c => ({
        campaign_id: `whop:${c.id}`,
        campaign_name: c.name || '',
        spend: parseFloat(c.summary?.spend) || 0,
      }))
      .filter(c => c.spend > 0);
  } catch (e) {
    console.warn('[whop] campaign spend fetch failed (serving FB-only):', e.message);
    return [];
  }
}
