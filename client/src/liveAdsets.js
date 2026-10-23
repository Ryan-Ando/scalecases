const EXCLUDED = new Set(['INACTIVE', 'DELETED', 'ARCHIVED', 'COMPLETED', 'OFF', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']);

export function countLiveAdsets(adsets, groupForCampaign, now = Date.now()) {
  const counts = {}, seen = new Set();
  for (const adset of adsets) {
    if (!adset.id || String(adset.id).startsWith('whop:') || seen.has(adset.id)) continue;
    seen.add(adset.id);
    const status = String(adset.effectiveStatus || adset.status || '').toUpperCase();
    if (!status || EXCLUDED.has(status) || EXCLUDED.has(String(adset.status || '').toUpperCase())) continue;
    if (adset.endTime && Date.parse(adset.endTime) <= now) continue;
    const group = groupForCampaign(adset.campaignName);
    if (group) counts[group] = (counts[group] || 0) + 1;
  }
  return counts;
}
