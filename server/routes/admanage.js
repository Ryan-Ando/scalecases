// AdManage launcher for the Relaunch tab: one new ad set per ad, copied from the newest
// active ad set of the chosen campaign, with that state's AdManage ad copy template.
// Writes go through AdManage's own key (ADMANAGE_API_KEY), not the read-only FB token, and
// every route here needs the app login token because these calls create live Meta objects.

import { Router } from 'express';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { hasAppToken } from './auth.js';
import { extractState, extractBrand } from './sheets.js';

const router = Router();
const API = 'https://api.admanage.ai';

router.use((req, res, next) => {
  if (!process.env.ADMANAGE_API_KEY) return res.status(503).json({ error: 'ADMANAGE_API_KEY is not set on the server' });
  if (!hasAppToken(req)) return res.status(401).json({ error: 'Log in again: AdManage actions need the app password (APP_PASSWORD must be set on the server)' });
  next();
});

async function am(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.ADMANAGE_API_KEY}`,
        'User-Agent': 'scalecases/1.0',   // Cloudflare in front of AdManage rejects library default agents
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && attempt < 2) {
      await new Promise(ok => setTimeout(ok, (parseInt(r.headers.get('retry-after'), 10) || 5) * 1000));
      continue;
    }
    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { error: text.slice(0, 300) }; }
    if (!r.ok || json.success === false) {
      const msg = json.error?.message || json.error || json.message || r.statusText;
      throw new Error(`AdManage ${method} ${path.split('?')[0]}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return json;
  }
}

let cache = { at: 0, accounts: null, campaigns: null, templates: null };
async function directory(force) {
  if (!force && cache.accounts && Date.now() - cache.at < 5 * 60_000) return cache;
  const accounts = ((await am('/v1/adaccounts')).data || [])
    .filter(a => ['meta', 'facebook'].includes(a.type) && a.workspaceId);
  const campaigns = [];
  for (const a of accounts) {
    for (let page = 1; page < 20; page++) {
      const r = await am(`/v1/campaigns?accountId=${a.accountId}&platform=facebook&limit=100&page=${page}`);
      const rows = r.data || [];
      campaigns.push(...rows.map(c => ({ ...c, accountName: a.accountName, workspaceId: a.workspaceId })));
      if (rows.length < 100) break;
    }
  }
  const templates = [];
  for (let page = 1; page < 20; page++) {
    const rows = (await am(`/v1/templates/ad-copy?pageSize=100&page=${page}`)).data || [];
    templates.push(...rows.map(t => ({ id: t.id, name: t.name, businessId: t.businessId })));
    if (rows.length < 100) break;
  }
  cache = { at: Date.now(), accounts, campaigns, templates };
  return cache;
}

// "LSS CO" / "Bulktide CO" — the same brand + state reading the campaign names use
function templateKey(name) {
  const st = extractState(name);
  return st ? `${extractBrand(name)} ${st}` : null;
}

// GET /api/admanage/setup?brand=LSS&state=CO — campaigns and copy templates for one group
router.get('/setup', async (req, res) => {
  try {
    const { brand, state } = req.query;
    const d = await directory(req.query.refresh === '1');
    const campaigns = d.campaigns
      .filter(c => extractState(c.campaignName) === state && extractBrand(c.campaignName) === brand)
      .sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || (b.totalSpend || 0) - (a.totalSpend || 0))
      .map(c => ({ campaignId: c.campaignId, name: c.campaignName, status: c.status, accountId: c.accountId, accountName: c.accountName, adSetCount: c.adSetCount }));
    const templates = d.templates.filter(t => templateKey(t.name) === `${brand} ${state}`);
    res.json({ campaigns, templates });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// POST /api/admanage/upload?fileName=x.mp4 — raw file body, relayed to AdManage's media
// storage (the browser can't: the storage refuses cross-origin uploads and the proxy needs the key)
router.post('/upload', async (req, res) => {
  try {
    const name = String(req.query.fileName || '').trim();
    const size = parseInt(req.headers['content-length'], 10);
    if (!name || !size) return res.status(400).json({ error: 'fileName and a file body are required' });
    const dot = name.lastIndexOf('.');
    // AdManage stores by file name; a suffix keeps a re-upload from replacing a live ad's media
    const stored = `${dot > 0 ? name.slice(0, dot) : name}_${crypto.randomBytes(4).toString('hex')}${dot > 0 ? name.slice(dot) : ''}`;
    const slot = await am('/v1/media/get-upload-url', { method: 'POST', body: { fileName: stored } });
    const put = await fetch(slot.url, {
      method: 'PUT', body: req,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream', 'Content-Length': String(size) },
    });
    if (!put.ok) throw new Error(`storage upload failed (${put.status})`);
    await am('/v1/media/confirm-upload', { method: 'POST', body: { url: slot.publicUrl, fileName: stored } });
    if (/\.(mp4|mov|m4v|webm)$/i.test(stored)) {
      am('/v1/media/generate-thumbnail', { method: 'POST', body: { url: slot.publicUrl } }).catch(() => {});
    }
    res.json({ url: slot.publicUrl });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// Newest ACTIVE ad set in the campaign, else the newest of any status. Meta IDs grow over
// time, so the largest ID is the most recently created. The list is paginated (25 by default).
async function sourceAdSet(accountId, campaignId) {
  const newest = rows => rows.filter(a => a.campaignId === campaignId)
    .sort((a, b) => (BigInt(b.adSetId) > BigInt(a.adSetId) ? 1 : -1))[0] || null;
  const list = async (filter, refresh) => {
    const rows = [];
    for (let page = 1; page < 50; page++) {
      const r = await am(`/v1/adsets?accountId=${accountId}&campaignId=${campaignId}${filter}&limit=100&page=${page}${refresh && page === 1 ? '&refresh=true' : ''}`);
      rows.push(...(r.data || []));
      if (page >= (r.pagination?.totalPages || 1)) break;
    }
    return rows;
  };
  return newest(await list('&status=ACTIVE', true)) || newest(await list('', false));
}

// POST /api/admanage/launch
// { accountId, campaignId, templateId, ads: [{ adName, mediaUrl }] }
router.post('/launch', async (req, res) => {
  const { accountId, campaignId, templateId, ads } = req.body || {};
  if (!accountId || !campaignId || !templateId || !Array.isArray(ads) || !ads.length) {
    return res.status(400).json({ error: 'accountId, campaignId, templateId and ads are required' });
  }
  if (ads.some(a => !a.adName || !a.mediaUrl)) return res.status(400).json({ error: 'every ad needs adName and mediaUrl' });
  const created = [];
  try {
    const d = await directory();
    const account = d.accounts.find(a => a.accountId === accountId);
    if (!account) throw new Error(`ad account ${accountId} is not connected in AdManage`);
    const template = (await am(`/v1/templates/ad-copy/${templateId}?businessId=${encodeURIComponent(accountId)}`)).data;
    const defaults = (await am(`/v1/launch-defaults?accountId=${accountId}`)).data?.defaults || {};
    if (!defaults.page) throw new Error(`no Facebook page saved in AdManage for ${account.accountName}`);
    const source = await sourceAdSet(accountId, campaignId);
    if (!source) throw new Error('the campaign has no ad set to copy');

    for (const ad of ads) {
      const r = await am('/v1/manage/duplicate-adset', {
        method: 'POST',
        body: { adSetId: source.adSetId, accountId, copyCount: 1, targetCampaignId: campaignId, newName: ad.adName,
                initialStatus: 'ACTIVE', deepCopy: false, workspaceId: account.workspaceId },
      });
      const id = r.results?.[0]?.newAdSetId;
      if (!id) throw new Error(`copying the ad set for "${ad.adName}" did not return an ad set id${r.results?.[0]?.error ? `: ${r.results[0].error}` : ''}`);
      created.push({ adName: ad.adName, adSetId: id });
    }

    const launch = await am('/v1/launch', {
      method: 'POST',
      body: {
        ads: ads.map((ad, i) => ({
          adName: ad.adName,
          adAccountId: accountId,
          workspaceId: account.workspaceId,
          title: template.defaultTitle,
          description: template.defaultDescription,
          cta: template.defaultCTA || 'LEARN_MORE',
          link: template.webLink,
          urlTags: template.urlTags || undefined,
          page: defaults.page,
          insta: defaults.insta,
          facebookName: defaults.facebookName || undefined,
          instaName: defaults.instaName || undefined,
          adSets: [{ value: created[i].adSetId, label: ad.adName }],
          media: [{ url: ad.mediaUrl }],
          launchPaused: false,
        })),
      },
    });
    res.json({ batchId: launch.adBatchId, source: { id: source.adSetId, name: source.name, status: source.status }, adSets: created });
  } catch (e) {
    // Ad sets already copied stay on Meta (empty, so they don't spend); report them so they can be reused or deleted
    res.status(502).json({ error: e.message, adSets: created });
  }
});

// GET /api/admanage/batch/:id — launch progress
router.get('/batch/:id', async (req, res) => {
  try { res.json(await am(`/v1/batch-status/${encodeURIComponent(req.params.id)}`)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

export default router;
