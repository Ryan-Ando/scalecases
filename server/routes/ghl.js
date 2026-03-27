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


// POST /api/ghl/tag-contacts
// Body: { contactIds: string[], tags: string[] }
// Adds the given tags to each contact (non-destructive — existing tags are preserved)
router.post('/tag-contacts', async (req, res) => {
  try {
    if (!token() || !locationId()) return res.status(503).json({ error: 'GHL not configured' });
    const { contactIds = [], tags = [] } = req.body;
    if (!contactIds.length || !tags.length) return res.json({ updated: 0 });

    const results = await Promise.allSettled(contactIds.map(async id => {
      const r = await fetch(`${GHL_API}/contacts/${id}/tags`, {
        method: 'POST',
        headers: GHL_HEADERS(),
        body: JSON.stringify({ tags }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`contact ${id}: ${r.status} ${txt.slice(0, 120)}`);
      }
      return id;
    }));

    const failed = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);
    if (failed.length) console.warn('[GHL] tag-contacts failures:', failed);

    res.json({ updated: results.filter(r => r.status === 'fulfilled').length, failed });
  } catch (err) {
    console.error('GHL tag-contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
