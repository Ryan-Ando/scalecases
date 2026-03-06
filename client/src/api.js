const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// Maps UI timeframe labels to Facebook date_preset values
const PRESET_MAP = {
  'Today': 'today',
  'Yesterday': 'yesterday',
  'Last 7 Days': 'last_7d',
  'Last 14 Days': 'last_14d',
  'Last 30 Days': 'last_30d',
  'This Month': 'this_month',
  'Last Month': 'last_month',
};

function toPreset(timeframe) {
  return PRESET_MAP[timeframe] || 'last_30d';
}

function timeframeToRange(timeframe, customStart, customEnd) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const ranges = {
    'Today':        { start: today, end: now },
    'Yesterday':    { start: new Date(today - 864e5), end: today },
    'Last 7 Days':  { start: new Date(today - 6 * 864e5), end: now },
    'Last 14 Days': { start: new Date(today - 13 * 864e5), end: now },
    'Last 30 Days': { start: new Date(today - 29 * 864e5), end: now },
    'This Month':   { start: new Date(now.getFullYear(), now.getMonth(), 1), end: now },
    'Last Month':   {
      start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end:   new Date(now.getFullYear(), now.getMonth(), 1),
    },
    'Custom Range': { start: customStart || null, end: customEnd || null },
  };

  return ranges[timeframe] || ranges['This Month'];
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

const api = {
  campaigns(timeframe) {
    return get(`/api/facebook/campaigns?date_preset=${toPreset(timeframe)}`);
  },

  adsets(timeframe, campaignId) {
    const base = `/api/facebook/adsets?date_preset=${toPreset(timeframe)}`;
    return get(campaignId ? `${base}&campaign_id=${campaignId}` : base);
  },

  ads(timeframe, adsetId) {
    const base = `/api/facebook/ads?date_preset=${toPreset(timeframe)}`;
    return get(adsetId ? `${base}&adset_id=${adsetId}` : base);
  },

  cases(timeframe, customStart, customEnd) {
    const { start, end } = timeframeToRange(timeframe, customStart, customEnd);
    const params = new URLSearchParams();
    if (start) params.set('start', start.toISOString());
    if (end)   params.set('end',   end.toISOString());
    return get(`/api/sheets/cases?${params}`);
  },

  sheetsConfig() {
    return get('/api/sheets/config');
  },

  ghlContacts(timeframe, customStart, customEnd) {
    const { start, end } = timeframeToRange(timeframe, customStart, customEnd);
    const params = new URLSearchParams();
    if (start) params.set('start', start.toISOString());
    if (end)   params.set('end',   end.toISOString());
    return get(`/api/ghl/contacts?${params}`);
  },

  dailyInsights(timeframe) {
    return get(`/api/facebook/daily?date_preset=${toPreset(timeframe)}`);
  },
};

// Merge cases data into campaigns by matching state abbreviation in campaign name.
// casesData: [{ state: 'VA', cases: 3 }, ...]
// campaigns: FB campaign objects with a `name` field
export function mergeCases(campaigns, casesData) {
  return campaigns.map(c => {
    const match = casesData.find(({ state }) =>
      new RegExp(`\\b${state}\\b`, 'i').test(c.name)
    );
    const cases = match ? match.cases : 0;
    return {
      ...c,
      cases,
      costPerCase: cases > 0 ? (parseFloat(c.spend) || 0) / cases : null,
    };
  });
}

export default api;
