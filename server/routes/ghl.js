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

// Extract state abbreviation from a GHL contact
function extractContactState(contact) {
  // Try env-configured field ID first
  const fieldId = process.env.GHL_FIELD_STATE;
  if (fieldId) {
    const f = (contact.customFields || []).find(f => f.id === fieldId);
    const v = (f?.value || '').toUpperCase().trim();
    if (v && US_STATES.has(v)) return v;
  }
  // Heuristic: scan all custom fields for a 2-letter US state value
  for (const f of (contact.customFields || [])) {
    const v = (f.value || '').toUpperCase().trim();
    if (v.length === 2 && US_STATES.has(v)) return v;
  }
  return '';
}

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

    function getCustomField(c, fieldId) {
      if (!fieldId) return '';
      const f = (c.customFields || []).find(f => f.id === fieldId);
      return (f?.value || '').trim();
    }

    const contacts = raw.map(c => ({
      id:          c.id,
      name:        [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || '(No name)',
      phone:       c.phone  || '',
      email:       c.email  || '',
      dateAdded:   c.dateAdded,
      utmCampaign: getCustomField(c, process.env.GHL_FIELD_UTM_CAMPAIGN),
      utmAdset:    getCustomField(c, 'DsiFBjELrBDfPKQ2tlH0'), // col H
      utmContent:  getCustomField(c, '2m1yjxI758bRlzTOv7J0'), // col I — used for matching
      utmTerm:     getCustomField(c, process.env.GHL_FIELD_UTM_TERM),
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

    // utm_content field ID — same field used in /contacts route (col I)
    const UTC_FIELD = '2m1yjxI758bRlzTOv7J0';

    const byRawNameState = {}; // "adName|STATE" → count
    let attributed = 0;

    for (const c of contacts) {
      const utmF   = (c.customFields || []).find(f => f.id === UTC_FIELD);
      const adName = (utmF?.value || '').trim();
      if (!adName) continue;

      const state = extractContactState(c);
      if (!state) continue;

      const key = `${adName}|${state}`;
      byRawNameState[key] = (byRawNameState[key] || 0) + 1;
      attributed++;
    }

    res.json({
      byRawNameState,
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
