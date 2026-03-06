import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();
const GHL_API = 'https://rest.gohighlevel.com/v1';

function token() {
  return process.env.GHL_API_KEY;
}

// Paginate through all GHL contacts
async function fetchAllContacts() {
  const all = [];
  let startAfter = null;
  let startAfterId = null;

  while (true) {
    const params = new URLSearchParams({ limit: 100 });
    if (startAfter)   params.set('startAfter', startAfter);
    if (startAfterId) params.set('startAfterId', startAfterId);

    const res = await fetch(`${GHL_API}/contacts/?${params}`, {
      headers: { Authorization: `Bearer ${token()}` },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || `GHL API error ${res.status}`);

    const batch = json.contacts || [];
    all.push(...batch);

    if (batch.length < 100) break;

    const last = batch[batch.length - 1];
    startAfter   = last.dateAdded ? new Date(last.dateAdded).getTime() : null;
    startAfterId = last.id;
  }

  return all;
}

// GET /api/ghl/contacts
// Returns contacts with UTM attribution fields for adset/ad level case matching
router.get('/contacts', async (req, res) => {
  try {
    if (!token()) return res.status(503).json({ error: 'GHL_API_KEY not configured' });

    const raw = await fetchAllContacts();

    const contacts = raw.map(c => ({
      id:          c.id,
      name:        [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || '(No name)',
      phone:       c.phone  || '',
      email:       c.email  || '',
      dateAdded:   c.dateAdded,
      // UTM fields — matched to FB ad names at adset/ad level
      utmCampaign: (c.utmCampaign || '').trim(),  // campaign name
      utmMedium:   (c.utmMedium   || '').trim(),  // adset name
      utmContent:  (c.utmContent  || '').trim(),  // ad name
    }));

    res.json(contacts);
  } catch (err) {
    console.error('GHL contacts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
