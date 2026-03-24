import { Router } from 'express';
import fetch from 'node-fetch';
import multer from 'multer';
import FormData from 'form-data';

const router = Router();
const FB_API = 'https://graph.facebook.com/v19.0';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

function token() { return process.env.FB_ACCESS_TOKEN; }

function allAdAccounts() {
  const accounts = (process.env.FB_AD_ACCOUNTS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!accounts.length) throw new Error('FB_AD_ACCOUNTS not set');
  return accounts.map(a => a.startsWith('act_') ? a : `act_${a}`);
}

function firstAdAccount() {
  return allAdAccounts()[0];
}

async function fetchCampaignsForAccount(account) {
  const all = [];
  let url = `${FB_API}/${account}/campaigns?fields=id,name,status,objective&limit=200&filtering=${encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]))}&access_token=${token()}`;
  while (url) {
    const r = await fetch(url);
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    all.push(...(json.data || []));
    url = json.paging?.next || null;
  }
  return all.filter(c => c.status === 'ACTIVE').map(c => ({ id: c.id, name: c.name, status: c.status, objective: c.objective, account_id: account }));
}

// GET /api/launcher/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const accounts = allAdAccounts();
    const results = await Promise.all(accounts.map(fetchCampaignsForAccount));
    const all = results.flat();
    res.json(all);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/launcher/adsets/:campaignId
router.get('/adsets/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    const all = [];
    let url = `${FB_API}/${campaignId}/adsets?fields=id,name,status,optimization_goal,billing_event&limit=100&access_token=${token()}`;
    while (url) {
      const r = await fetch(url);
      const json = await r.json();
      if (json.error) throw new Error(json.error.message);
      all.push(...(json.data || []));
      url = json.paging?.next || null;
    }
    res.json(all.filter(a => ['ACTIVE', 'PAUSED'].includes(a.status)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/launcher/adset — create a new adset
router.post('/adset', async (req, res) => {
  try {
    const {
      name, campaignId, accountId, pageId,
      conversionLocation, pixelId, conversionEvent,
      costPerResultGoal, attributionSetting,
      budgetType, budgetAmount, startTime, endTime,
      ageMin, ageMax, genders,
      advantagePlusAudience, countries, customAudienceIds, targetingSpec,
      placementsType, manualPlacements, languages,
    } = req.body;

    const account = accountId || firstAdAccount();

    // Optimization goal by conversion location
    const optGoalMap = {
      WEBSITE:         'OFFSITE_CONVERSIONS',
      LEAD_GENERATION: 'LEAD_GENERATION',
      CALLS:           'QUALITY_CALL',
      MESSAGING:       'REPLIES',
      APP:             'APP_INSTALLS',
    };
    const optimizationGoal = optGoalMap[conversionLocation] || 'OFFSITE_CONVERSIONS';

    // Build targeting
    let targeting;
    if (targetingSpec) {
      try { targeting = JSON.parse(targetingSpec); }
      catch { throw new Error('Invalid targeting JSON'); }
    } else {
      targeting = {
        geo_locations: { countries: (countries || 'US').split(',').map(s => s.trim()).filter(Boolean) },
      };
      // Skip demographic restrictions when using Advantage+ audience (they're ignored and can cause API errors)
      if (!advantagePlusAudience) {
        targeting.age_min = parseInt(ageMin) || 18;
        targeting.age_max = parseInt(ageMax) || 65;
        const g = parseInt(genders);
        if (g === 1 || g === 2) targeting.genders = [g];
      }
      if (customAudienceIds) {
        const ids = customAudienceIds.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length) targeting.custom_audiences = ids.map(id => ({ id }));
      }
    }

    // Manual placements
    if (placementsType === 'MANUAL' && manualPlacements) {
      const mp = typeof manualPlacements === 'string' ? JSON.parse(manualPlacements) : manualPlacements;
      const placementMap = {
        fb_feed:         { platform: 'facebook',         position: 'feed' },
        ig_feed:         { platform: 'instagram',        position: 'stream' },
        fb_story:        { platform: 'facebook',         position: 'story' },
        ig_story:        { platform: 'instagram',        position: 'story' },
        fb_reels:        { platform: 'facebook',         position: 'facebook_reels' },
        ig_reels:        { platform: 'instagram',        position: 'reels' },
        fb_marketplace:  { platform: 'facebook',         position: 'marketplace' },
        fb_right_column: { platform: 'facebook',         position: 'right_hand_column' },
        audience_network:{ platform: 'audience_network', position: 'classic' },
        messenger_inbox: { platform: 'messenger',        position: 'messenger_home' },
        messenger_story: { platform: 'messenger',        position: 'story' },
      };
      const platforms = new Set();
      const fbPos = [], igPos = [], anPos = [], msPos = [];
      for (const [key, enabled] of Object.entries(mp)) {
        if (!enabled) continue;
        const pm = placementMap[key];
        if (!pm) continue;
        platforms.add(pm.platform);
        if (pm.platform === 'facebook')         fbPos.push(pm.position);
        else if (pm.platform === 'instagram')   igPos.push(pm.position);
        else if (pm.platform === 'audience_network') anPos.push(pm.position);
        else if (pm.platform === 'messenger')   msPos.push(pm.position);
      }
      if (platforms.size) {
        targeting.publisher_platforms = [...platforms];
        if (fbPos.length) targeting.facebook_positions = fbPos;
        if (igPos.length) targeting.instagram_positions = igPos;
        if (anPos.length) targeting.audience_network_positions = anPos;
        if (msPos.length) targeting.messenger_positions = msPos;
      }
    }

    // Budget (cents)
    const budgetCents = Math.round(parseFloat(budgetAmount || 0) * 100);
    const budgetKey = budgetType === 'LIFETIME' ? 'lifetime_budget' : 'daily_budget';

    // Attribution spec
    const attrMap = {
      '7D_CLICK_1D_VIEW': [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
      '7D_CLICK':         [{ event_type: 'CLICK_THROUGH', window_days: 7 }],
      '1D_CLICK':         [{ event_type: 'CLICK_THROUGH', window_days: 1 }],
      '1D_VIEW':          [{ event_type: 'VIEW_THROUGH',  window_days: 1 }],
    };

    // Languages (numeric Meta locale IDs)
    if (languages) {
      const locales = languages.split(',').map(s => parseInt(s.trim())).filter(Boolean);
      if (locales.length) targeting.locales = locales;
    }

    const body = {
      name,
      campaign_id: campaignId,
      optimization_goal: optimizationGoal,
      billing_event: 'IMPRESSIONS',
      [budgetKey]: budgetCents,
      targeting,
      status: 'PAUSED',
      access_token: token(),
      ...(advantagePlusAudience ? { targeting_automation: { advantage_audience: 1 } } : {}),
    };

    // Bid strategy
    if (costPerResultGoal && parseFloat(costPerResultGoal) > 0) {
      body.bid_strategy = 'COST_CAP';
      body.bid_amount = Math.round(parseFloat(costPerResultGoal) * 100);
    } else {
      body.bid_strategy = 'LOWEST_COST_WITHOUT_CAP';
    }

    // Promoted object (pixel + conversion event)
    const promotedObject = {};
    if (pageId) promotedObject.page_id = pageId;
    if (pixelId) {
      promotedObject.pixel_id = pixelId;
      if (conversionEvent) promotedObject.custom_event_type = conversionEvent;
    }
    if (Object.keys(promotedObject).length) body.promoted_object = promotedObject;

    if (startTime) body.start_time = new Date(startTime).toISOString();
    if (endTime)   body.end_time   = new Date(endTime).toISOString();
    if (attrMap[attributionSetting]) body.attribution_spec = attrMap[attributionSetting];

    const r = await fetch(`${FB_API}/${account}/adsets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (json.error) throw new Error(`${json.error.error_user_msg || json.error.message} (code: ${json.error.code})`);
    res.json({ adset_id: json.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/launcher/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const account = req.body.accountId || firstAdAccount();
    const file = req.file;
    if (!file) throw new Error('No file provided');
    const isVideo = file.mimetype.startsWith('video/');
    const fd = new FormData();
    fd.append('access_token', token());
    if (isVideo) {
      fd.append('source', file.buffer, { filename: file.originalname, contentType: file.mimetype });
      fd.append('title', file.originalname);
      const r = await fetch(`${FB_API}/${account}/advideos`, { method: 'POST', body: fd, headers: fd.getHeaders() });
      const json = await r.json();
      if (json.error) throw new Error(json.error.message);
      res.json({ type: 'video', video_id: json.id });
    } else {
      fd.append(file.originalname, file.buffer, { filename: file.originalname, contentType: file.mimetype });
      const r = await fetch(`${FB_API}/${account}/adimages`, { method: 'POST', body: fd, headers: fd.getHeaders() });
      const json = await r.json();
      if (json.error) throw new Error(json.error.message);
      const first = Object.values(json.images || {})[0];
      if (!first) throw new Error('No image hash returned from Facebook');
      res.json({ type: 'image', image_hash: first.hash });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/launcher/creative
router.post('/creative', async (req, res) => {
  try {
    const account = req.body.accountId || firstAdAccount();
    const {
      name, pageId,
      primaryText, headline, description,
      ctaType, destinationUrl, urlParameters,
      mediaType, videoId, imageHash,
    } = req.body;

    const finalUrl = (destinationUrl || '') + (urlParameters ? (urlParameters.startsWith('?') ? urlParameters : `?${urlParameters}`) : '');

    let objectStorySpec;
    if (mediaType === 'video') {
      const videoData = {
        video_id: videoId,
        message: primaryText,
        call_to_action: { type: ctaType, value: { link: finalUrl } },
      };
      if (headline)     videoData.title            = headline;
      if (description)  videoData.link_description = description;
      objectStorySpec = { page_id: pageId, video_data: videoData };
    } else {
      const linkData = {
        image_hash: imageHash,
        message: primaryText,
        link: finalUrl,
        call_to_action: { type: ctaType, value: { link: finalUrl } },
      };
      if (headline)    linkData.name        = headline;
      if (description) linkData.description = description;
      objectStorySpec = { page_id: pageId, link_data: linkData };
    }

    const creativeBody = { name, object_story_spec: objectStorySpec, access_token: token() };

    // Creative advancements — creativeEnhancements is { [featureId]: boolean }
    const { creativeEnhancements } = req.body;
    if (creativeEnhancements && typeof creativeEnhancements === 'object') {
      const enabled = Object.entries(creativeEnhancements).filter(([, v]) => v).map(([k]) => k);
      if (enabled.length) {
        const features = {};
        for (const id of enabled) {
          if (id !== 'advantage_plus_creative') features[id] = { enroll_status: 'OPT_IN' };
        }
        if (Object.keys(features).length) {
          creativeBody.degrees_of_freedom_spec = { creative_features_spec: features };
        }
        if (enabled.includes('advantage_plus_creative')) {
          creativeBody.advantage_plus_creative = { enroll_status: 'OPT_IN' };
        }
      }
    }

    const r = await fetch(`${FB_API}/${account}/adcreatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creativeBody),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    res.json({ creative_id: json.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/launcher/ad
router.post('/ad', async (req, res) => {
  try {
    const account = firstAdAccount();
    const { name, adsetId, creativeId } = req.body;
    const r = await fetch(`${FB_API}/${account}/ads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        adset_id: adsetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
        access_token: token(),
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    res.json({ ad_id: json.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

export default router;
