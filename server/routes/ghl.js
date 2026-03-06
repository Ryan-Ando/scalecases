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

// Paginate through all GHL contacts for the sub-account
async function fetchAllContacts() {
  const all = [];
  let page = 1;

  while (true) {
    const params = new URLSearchParams({ locationId: locationId(), limit: 100, page });

    const res = await fetch(`${GHL_API}/contacts/?${params}`, {
      headers: GHL_HEADERS(),
    });
    const text = await res.text();
    console.error('GHL raw response:', res.status, text.slice(0, 500));
    if (!res.ok) throw new Error(`GHL API error ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);

    const batch = json.contacts || [];
    all.push(...batch);

    if (batch.length < 100) break;
    page++;
  }

  return all;
}

// GET /api/ghl/contacts
// Returns contacts with UTM attribution fields for adset/ad level case matching
router.get('/contacts', async (req, res) => {
  try {
    if (!token() || !locationId()) return res.status(503).json({ error: 'GHL_API_KEY or GHL_LOCATION_ID not configured' });

    const raw = await fetchAllContacts();

    const contacts = raw.map(c => ({
      id:          c.id,
      name:        [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || '(No name)',
      phone:       c.phone  || '',
      email:       c.email  || '',
      dateAdded:   c.dateAdded,
      utmCampaign: (c.utmCampaign || '').trim(),
      utmMedium:   (c.utmMedium   || '').trim(),
      utmContent:  (c.utmContent  || '').trim(),
      customFields: c.customFields || [],
    }));

    res.json(contacts);
  } catch (err) {
    console.error('GHL contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
