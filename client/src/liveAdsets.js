const EXCLUDED = new Set(['INACTIVE', 'DELETED', 'ARCHIVED', 'COMPLETED', 'OFF', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']);

// CBO = the budget lives on the campaign (Advantage campaign budget), not on the ad set
export const isCboAdset = adset => (parseFloat(adset.campaignDailyBudget) || 0) > 0 || (parseFloat(adset.campaignLifetimeBudget) || 0) > 0;

// Live ad sets per group, split by campaign type: { group: { cbo, normal } }
export function countLiveAdsetsByType(adsets, groupForCampaign, now = Date.now()) {
  const counts = {}, seen = new Set();
  for (const adset of adsets) {
    if (!adset.id || String(adset.id).startsWith('whop:') || seen.has(adset.id)) continue;
    seen.add(adset.id);
    if (adset.hasEnabledAds !== true) continue;
    const status = String(adset.effectiveStatus || adset.status || '').toUpperCase();
    if (!status || EXCLUDED.has(status) || EXCLUDED.has(String(adset.status || '').toUpperCase())) continue;
    if (adset.endTime && Date.parse(adset.endTime) <= now) continue;
    const group = groupForCampaign(adset.campaignName);
    if (!group) continue;
    const c = counts[group] || (counts[group] = { cbo: 0, normal: 0 });
    c[isCboAdset(adset) ? 'cbo' : 'normal']++;
  }
  return counts;
}

export function countLiveAdsets(adsets, groupForCampaign, now = Date.now()) {
  const byType = countLiveAdsetsByType(adsets, groupForCampaign, now);
  return Object.fromEntries(Object.entries(byType).map(([g, c]) => [g, c.cbo + c.normal]));
}
