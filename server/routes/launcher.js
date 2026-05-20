// Read-only campaign/adset listing endpoints used by State Variations.
// All write operations (create adset/creative/ad, upload media) were removed
// to keep the app strictly within the ads_read OAuth scope.

import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();
const FB_API = 'https://graph.facebook.com/v19.0';

function token() { return process.env.FB_ACCESS_TOKEN; }

function allAdAccounts() {
  const accounts = (process.env.FB_AD_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!accounts.length) throw new Error('FB_AD_ACCOUNTS not set');
  return accounts.map(a => a.startsWith('act_') ? a : `act_${a}`);
}

async function fetchCampaignsForAccount(account) {
  const all = [];
  let url = `${FB_API}/${account}/campaigns?fields=id,name,status,objective&limit=200&filtering=${encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]))}&access_token=${token()}`;
  while (url) {
    const r = await fetch(url);
    const json = await r.json();
    if (json.error) throw new Error(`${json.error.error_user_msg || json.error.message} (code: ${json.error.code})`);
    all.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  return all
    .filter(c => c.status === 'ACTIVE')
    .map(c => ({ id: c.id, name: c.name, status: c.status, objective: c.objective, account_id: account }));
}

// GET /api/launcher/campaigns — list active campaigns across all configured ad accounts
router.get('/campaigns', async (req, res) => {
  try {
    const accounts = allAdAccounts();
    const results = await Promise.all(accounts.map(fetchCampaignsForAccount));
    res.json(results.flat());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/launcher/adsets/:campaignId — list active/paused adsets under a campaign
router.get('/adsets/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const all = [];
    let url = `${FB_API}/${campaignId}/adsets?fields=id,name,status,optimization_goal,billing_event&limit=100&access_token=${token()}`;
    while (url) {
      const r = await fetch(url);
      const json = await r.json();
      if (json.error) throw new Error(`${json.error.error_user_msg || json.error.message} (code: ${json.error.code})`);
      all.push(...(json.data || []));
      url = json.paging?.next || null;
    }
    res.json(all.filter(a => ['ACTIVE', 'PAUSED'].includes(a.status)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
