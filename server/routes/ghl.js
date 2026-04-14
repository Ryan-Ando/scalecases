import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();
const GHL_API = 'https://services.leadconnectorhq.com';

function token() {
  return process.env.GHL_API_KEY;
}

function locationId() {
  return process.env.GHL_LOCATION_ID;
}

const GHL_HEADERS = () => ({
  Authorization: `Bearer ${token()}`,
  Version: '2021-07-28',
  'Content-Type': 'application/json',
});


const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch one page with automatic retry on 429 (up to 5 attempts).
async function fetchPage(url) {
  const MAX_RETRIES = 5;
  let delay = 2000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res  = await fetch(url, { headers: GHL_HEADERS() });
    const text = await res.text();
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0') * 1000 || delay;
      console.warn(`[GHL] 429 rate limit — waiting ${retryAfter}ms (attempt ${attempt}/${MAX_RETRIES})`);
      if (attempt === MAX_RETRIES) throw new Error(`GHL API error 429: ${text.slice(0, 200)}`);
      await sleep(retryAfter);
      delay = Math.min(delay * 2, 30000);
      continue;
    }
    if (!res.ok) throw new Error(`GHL API error ${res.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  }
}

// Paginate all GHL contacts and filter by date range client-side.
// GHL v2 does not support date filtering params; sortOrder is not accepted.
async function fetchAllContacts(startMs, endMs) {
  const all = [];
  let startAfter   = null;
  let startAfterId = null;

  while (true) {
    const params = new URLSearchParams({
      locationId: locationId(),
      limit: 100,
      sortBy: 'date_added',
    });
    if (startAfter)   params.set('startAfter',   startAfter);
    if (startAfterId) params.set('startAfterId', startAfterId);

    const json = await fetchPage(`${GHL_API}/contacts/?${params}`);
    console.log('[GHL] page keys:', Object.keys(json), '| contacts:', (json.contacts||[]).length, '| meta:', JSON.stringify(json.meta || json.pagination || null));

    const batch = json.contacts || [];
    if (!batch.length) break;

    for (const c of batch) {
      const t = c.dateAdded ? new Date(c.dateAdded).getTime() : null;
      if (startMs && t && t < startMs) continue;
      if (endMs   && t && t > endMs)   continue;
      all.push(c);
    }

    console.log(`[GHL] batch=${batch.length} in-range=${all.length} lastDateAdded=${batch[batch.length-1]?.dateAdded} lastId=${batch[batch.length-1]?.id}`);

    if (batch.length < 100) break;

    const last = batch[batch.length - 1];
    startAfter   = last.dateAdded ? new Date(last.dateAdded).getTime() : null;
    startAfterId = last.id || null;
    console.log(`[GHL] next cursor startAfter=${startAfter} startAfterId=${startAfterId}`);
    if (!startAfterId) break;
  }

  return all;
}

const US_STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']);

// Read a field from the attributionSource object — GHL uses camelCase keys
function getAttr(contact, ...keys) {
  const src = contact.attributionSource || {};
  for (const k of keys) {
    const v = (src[k] || '').trim();
    if (v) return v;
  }
  return '';
}

// Read a GHL custom field value by field ID
function getCustomField(contact, fieldId) {
  if (!fieldId) return '';
  const f = (contact.customFields || []).find(f => f.id === fieldId);
  return (f?.value || '').trim();
}

// Extract the FB ad name from a contact.
// Priority: attributionSource.utmContent → utmMedium → custom field fallback
function extractAdName(contact) {
  const fromAttr = getAttr(contact, 'utmContent', 'utm_content', 'utmMedium', 'utm_medium');
  if (fromAttr) return fromAttr;
  // Fallback: custom field that was being used before
  return getCustomField(contact, '2m1yjxI758bRlzTOv7J0');
}

// Extract state abbreviation from a contact.
// Priority: env-configured custom field → attribution campaign name → heuristic scan
function extractContactState(contact) {
  // 1. Env-configured custom field (e.g. "What state was your accident in?")
  const fieldId = process.env.GHL_FIELD_STATE;
  if (fieldId) {
    const v = getCustomField(contact, fieldId).toUpperCase();
    if (v.length === 2 && US_STATES.has(v)) return v;
  }
  // 2. Parse state from attributionSource.utmCampaign ("LSS TX", "LSS FL 2")
  const campaign = getAttr(contact, 'utmCampaign', 'utm_campaign', 'campaign');
  if (campaign) {
    const tokens = campaign.trim().split(/[-\s]+/);
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i].toUpperCase();
      if (t.length === 2 && US_STATES.has(t)) return t;
    }
  }
  // 3. Heuristic: scan all custom fields for a 2-letter state value
  for (const f of (contact.customFields || [])) {
    const v = (f.value || '').toUpperCase().trim();
    if (v.length === 2 && US_STATES.has(v)) return v;
  }
  return '';
}

// ── GHL leads cache ──────────────────────────────────────────────────────────
// Fetches all "new lead" tagged contacts once, stores minimal records, refreshes hourly.
// Each record: { adId, state, campaign, dateMs }
const _ghlCache = { leads: null, fetchedAt: null, running: false, error: null };

async function refreshGhlCache() {
  if (_ghlCache.running) return;
  _ghlCache.running = true;
  console.log('[GHL] cache refresh started');
  try {
    const all = await fetchAllContacts(null, null);
    _ghlCache.leads = all
      .filter(c => (c.tags || []).some(t => (t || '').toLowerCase().trim() === 'new lead'))
      .map(c => ({
        adId:     getAttr(c, 'utmTerm', 'utm_term', 'term') || getCustomField(c, process.env.GHL_FIELD_UTM_TERM),
        content:  getAttr(c, 'utmContent', 'utm_content', 'content'), // ad name
        state:    extractContactState(c),
        campaign: getAttr(c, 'utmCampaign', 'utm_campaign', 'campaign'),
        dateMs:   c.dateAdded ? new Date(c.dateAdded).getTime() : null,
      }));
    // Keep ALL new leads in cache (not just those with adId) so that byCampaign
    // and byDate totals are complete. byAdId is only populated for leads that have
    // a utm_term (adset ID) — handled in the endpoint loop below.
    const withAdId = _ghlCache.leads.filter(c => c.adId).length;
    _ghlCache.fetchedAt = new Date().toISOString();
    _ghlCache.error = null;
    console.log(`[GHL] cache refreshed — ${_ghlCache.leads.length} new leads total, ${withAdId} with adset ID`);
  } catch (err) {
    _ghlCache.error = err.message;
    console.error('[GHL] cache refresh error:', err.message);
  } finally {
    _ghlCache.running = false;
  }
}

setTimeout(refreshGhlCache, 10_000);
setInterval(refreshGhlCache, 60 * 60 * 1000);

// GET /api/ghl/leads-by-adid?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns GHL "new lead" contacts aggregated by FB ad ID, state, campaign, and date.
router.get('/leads-by-adid', (req, res) => {
  if (!_ghlCache.leads) {
    return res.json({ ready: false, byAdId: {}, byDate: {}, byCampaign: {}, fetchedAt: null });
  }

  const { start, end } = req.query;
  const startMs = start ? new Date(start).getTime() : null;
  const endMs   = end   ? new Date(end + 'T23:59:59.999Z').getTime() : null;

  const byAdId     = {};
  const byDate     = {};
  const byCampaign = {};

  for (const c of _ghlCache.leads) {
    if (startMs && c.dateMs && c.dateMs < startMs) continue;
    if (endMs   && c.dateMs && c.dateMs > endMs)   continue;

    if (c.adId) {
      if (!byAdId[c.adId]) byAdId[c.adId] = { total: 0, byState: {}, byContent: {} };
      byAdId[c.adId].total++;
      if (c.state) byAdId[c.adId].byState[c.state] = (byAdId[c.adId].byState[c.state] || 0) + 1;

      // Per-ad breakdown via utm_content (ad name) — distinguishes ads within the same adset
      if (c.content) {
        if (!byAdId[c.adId].byContent[c.content]) byAdId[c.adId].byContent[c.content] = { total: 0, byState: {} };
        byAdId[c.adId].byContent[c.content].total++;
        if (c.state) byAdId[c.adId].byContent[c.content].byState[c.state] = (byAdId[c.adId].byContent[c.content].byState[c.state] || 0) + 1;
      }
    }

    if (c.dateMs) {
      const day = new Date(c.dateMs).toISOString().slice(0, 10);
      byDate[day] = (byDate[day] || 0) + 1;
    }

    if (c.campaign) byCampaign[c.campaign] = (byCampaign[c.campaign] || 0) + 1;
  }

  res.json({ ready: true, byAdId, byDate, byCampaign, fetchedAt: _ghlCache.fetchedAt, cacheSize: _ghlCache.leads.length });
});

// POST /api/ghl/refresh — trigger a manual cache refresh
router.post('/refresh', (req, res) => {
  if (_ghlCache.running) return res.json({ ok: false, message: 'already running' });
  refreshGhlCache();
  res.json({ ok: true, message: 'GHL cache refresh started' });
});

// GET /api/ghl/debug — inspect cache state and sample records
router.get('/debug', async (req, res) => {
  const leads = _ghlCache.leads;
  if (!leads) {
    return res.json({ ready: false, running: _ghlCache.running, error: _ghlCache.error });
  }

  // Count how many have adId vs missing
  const withAdId    = leads.filter(l => l.adId).length;
  const withState   = leads.filter(l => l.state).length;
  const withCampaign = leads.filter(l => l.campaign).length;
  const missingAdId = leads.filter(l => !l.adId).length;

  // Sample raw contact to see attributionSource structure
  const rawSample = await (async () => {
    try {
      const params = new URLSearchParams({ locationId: locationId(), limit: 1 });
      const json = await fetchPage(`${GHL_API}/contacts/?${params}`);
      const c = (json.contacts || [])[0];
      if (!c) return null;
      return { tags: c.tags, attributionSource: c.attributionSource, customFields: (c.customFields || []).slice(0, 5) };
    } catch { return null; }
  })();

  res.json({
    ready: true,
    fetchedAt: _ghlCache.fetchedAt,
    total: leads.length,
    withAdId,
    withState,
    withCampaign,
    missingAdId,
    sampleLeads: leads.slice(0, 5),
    rawContactSample: rawSample,
  });
});

// Returns { startMs, endMs } for "this month" by default
function thisMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { startMs: start.getTime(), endMs: Date.now() };
}

// GET /api/ghl/contacts?start=ISO&end=ISO
// Returns contacts with UTM attribution fields for adset/ad level case matching
router.get('/contacts', async (req, res) => {
  try {
    if (!token() || !locationId()) return res.status(503).json({ error: 'GHL_API_KEY or GHL_LOCATION_ID not configured' });

    const { start, end } = req.query;
    const startMs = start ? new Date(start).getTime() : thisMonthRange().startMs;
    const endMs   = end   ? new Date(end).getTime()   : thisMonthRange().endMs;

    const raw = await fetchAllContacts(startMs, endMs);

    const contacts = raw.map(c => ({
      id:          c.id,
      name:        [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || '(No name)',
      phone:       c.phone  || '',
      email:       c.email  || '',
      dateAdded:   c.dateAdded,
      // Attribution source (automatically captured from URL params — preferred over form fields)
      utmSource:   getAttr(c, 'utmSource',   'utm_source',   'source'),
      utmMedium:   getAttr(c, 'utmMedium',   'utm_medium',   'medium'),
      utmContent:  extractAdName(c),   // ad name — tries attribution first, then custom field
      utmTerm:     getAttr(c, 'utmTerm',     'utm_term',     'term') || getCustomField(c, process.env.GHL_FIELD_UTM_TERM),
      utmCampaign: getAttr(c, 'utmCampaign', 'utm_campaign', 'campaign') || getCustomField(c, process.env.GHL_FIELD_UTM_CAMPAIGN),
      state:       extractContactState(c),
      customFields: c.customFields || [],
    }));

    res.json(contacts);
  } catch (err) {
    console.error('GHL contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/ghl/leads?start=YYYY-MM-DD&end=YYYY-MM-DD
// Aggregates GHL contacts by utm_content (FB ad name) + state.
// Used as the source-of-truth lead count in the ads tracker instead of FB data.
router.get('/leads', async (req, res) => {
  try {
    if (!token() || !locationId()) return res.status(503).json({ error: 'GHL not configured' });

    const { start, end } = req.query;
    const startMs = start ? new Date(start).getTime()                   : null;
    const endMs   = end   ? new Date(end + 'T23:59:59.999Z').getTime()  : null;

    const contacts = await fetchAllContacts(startMs, endMs);

    const byRawNameState = {}; // "adName|STATE" → count
    const byDate         = {}; // "YYYY-MM-DD"   → count  (for chart)
    let attributed = 0;

    for (const c of contacts) {
      const adName = extractAdName(c);
      if (!adName) continue;

      const state = extractContactState(c);
      if (!state) continue;

      const date = (c.dateAdded || '').slice(0, 10); // YYYY-MM-DD

      const key = `${adName}|${state}`;
      byRawNameState[key] = (byRawNameState[key] || 0) + 1;
      if (date) byDate[date] = (byDate[date] || 0) + 1;
      attributed++;
    }

    res.json({
      byRawNameState,
      byDate,
      total:      contacts.length,
      attributed,
      dateRange:  { start: start || null, end: end || null },
      fetchedAt:  new Date().toISOString(),
    });
  } catch (err) {
    console.error('GHL leads error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/ghl/tag-contacts
// Body: { contactIds: string[], tags: string[] }
// Adds the given tags to each contact (non-destructive — existing tags are preserved)
router.post('/tag-contacts', async (req, res) => {
  try {
    if (!token() || !locationId()) return res.status(503).json({ error: 'GHL not configured' });
    const { contactIds = [], tags = [] } = req.body;
    if (!contactIds.length || !tags.length) return res.json({ updated: 0 });

    // Process in small batches to avoid 429 rate limiting
    const BATCH_SIZE = 5;
    const BATCH_DELAY = 1200; // ms between batches
    const TAG_RETRY_DELAY = 2000;
    const succeeded_ids = [];
    const failed = [];

    async function tagOne(id) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await fetch(`${GHL_API}/contacts/${id}/tags`, {
          method: 'POST',
          headers: GHL_HEADERS(),
          body: JSON.stringify({ tags }),
        });
        if (r.status === 429) {
          if (attempt === 3) { failed.push(`contact ${id}: 429 rate limit`); return; }
          await sleep(TAG_RETRY_DELAY * attempt);
          continue;
        }
        if (!r.ok) {
          const txt = await r.text();
          failed.push(`contact ${id}: ${r.status} ${txt.slice(0, 120)}`);
          return;
        }
        succeeded_ids.push(id);
        return;
      }
    }

    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      const batch = contactIds.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(id => tagOne(id)));
      if (i + BATCH_SIZE < contactIds.length) await sleep(BATCH_DELAY);
    }

    const succeeded = succeeded_ids.length;
    if (failed.length) console.warn('[GHL] tag-contacts failures:', failed);
    console.log(`[GHL] tag-contacts: ${succeeded} tagged, ${failed.length} failed`);

    res.json({ updated: succeeded, failed });
  } catch (err) {
    console.error('GHL tag-contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
