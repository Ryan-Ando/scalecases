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


// Paginate through all GHL contacts using cursor-based pagination (startAfter / startAfterId)
async function fetchAllContacts(startMs, endMs) {
  const all = [];
  let startAfter   = null;
  let startAfterId = null;

  while (true) {
    const params = new URLSearchParams({ locationId: locationId(), limit: 100 });
    if (startMs) params.set('startDate', startMs);
    if (endMs)   params.set('endDate',   endMs);
    if (startAfter)   params.set('startAfter',   startAfter);
    if (startAfterId) params.set('startAfterId', startAfterId);

    const res = await fetch(`${GHL_API}/contacts/?${params}`, {
      headers: GHL_HEADERS(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GHL API error ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);

    const batch = json.contacts || [];
    all.push(...batch);

    // GHL returns nextPageUrl or meta with cursor info when there are more pages
    if (batch.length < 100) break;

    // Use the last contact's dateAdded (ms) and id as the cursor for the next page
    const last = batch[batch.length - 1];
    startAfter   = last.dateAdded ? new Date(last.dateAdded).getTime() : null;
    startAfterId = last.id || null;
    if (!startAfter && !startAfterId) break;
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

    const campaignFieldId = process.env.GHL_FIELD_UTM_CAMPAIGN;
    const mediumFieldId   = process.env.GHL_FIELD_UTM_MEDIUM;
    const contentFieldId  = process.env.GHL_FIELD_UTM_CONTENT;
    const termFieldId     = process.env.GHL_FIELD_UTM_TERM;

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
      utmCampaign:  getCustomField(c, campaignFieldId) || (c.utmCampaign || '').trim(),
      utmMedium:    getCustomField(c, mediumFieldId)   || (c.utmMedium   || '').trim(),
      utmContent:   getCustomField(c, contentFieldId)  || (c.utmContent  || '').trim(),
      utmTerm:      getCustomField(c, termFieldId) || (c.utmTerm || '').trim(),
      customFields: c.customFields || [],
    }));

    res.json(contacts);
  } catch (err) {
    console.error('GHL contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
