const OFF = new Set(['OFF', 'INACTIVE', 'PAUSED', 'ADSET_PAUSED', 'CAMPAIGN_PAUSED', 'DELETED', 'ARCHIVED', 'COMPLETED']);

export function enabledAdsetIds(ads) {
  return new Set(ads.filter(ad => ad.adset_id && ad.status === 'ACTIVE'
    && !OFF.has(ad.effective_status)).map(ad => ad.adset_id));
}
