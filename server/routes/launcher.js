import { Router } from 'express';
import fetch from 'node-fetch';
import multer from 'multer';
import FormData from 'form-data';

const router = Router();
const FB_API = 'https://graph.facebook.com/v19.0';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

function token() {
  return process.env.FB_ACCESS_TOKEN;
}

function firstAdAccount() {
  const raw = (process.env.FB_AD_ACCOUNTS || '').split(',')[0]?.trim();
  if (!raw) throw new Error('FB_AD_ACCOUNTS not set');
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

// GET /api/launcher/campaigns
router.get('/campaigns', async (req, res) => {
  try {
    const account = firstAdAccount();
    const all = [];
    let url = `${FB_API}/${account}/campaigns?fields=id,name,status,objective&limit=200&filtering=${encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE', 'PAUSED'] }]))}&access_token=${token()}`;

    while (url) {
      const r = await fetch(url);
      const json = await r.json();
      if (json.error) throw new Error(json.error.message);
      all.push(...(json.data || []));
      url = json.paging?.next || null;
    }

    res.json(all.map(c => ({ id: c.id, name: c.name, status: c.status, objective: c.objective })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

    const filtered = all.filter(a => ['ACTIVE', 'PAUSED'].includes(a.status));
    res.json(filtered);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/launcher/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const account = firstAdAccount();
    const file = req.file;
    if (!file) throw new Error('No file provided');

    const isVideo = file.mimetype.startsWith('video/');
    const fd = new FormData();
    fd.append('access_token', token());

    if (isVideo) {
      fd.append('source', file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });
      fd.append('title', file.originalname);

      const r = await fetch(`${FB_API}/${account}/advideos`, {
        method: 'POST',
        body: fd,
        headers: fd.getHeaders(),
      });
      const json = await r.json();
      if (json.error) throw new Error(json.error.message);
      res.json({ type: 'video', video_id: json.id });
    } else {
      fd.append(file.originalname, file.buffer, {
        filename: file.originalname,
        contentType: file.mimetype,
      });

      const r = await fetch(`${FB_API}/${account}/adimages`, {
        method: 'POST',
        body: fd,
        headers: fd.getHeaders(),
      });
      const json = await r.json();
      if (json.error) throw new Error(json.error.message);
      // adimages returns { images: { [filename]: { hash, ... } } }
      const imagesObj = json.images || {};
      const first = Object.values(imagesObj)[0];
      if (!first) throw new Error('No image hash returned from Facebook');
      res.json({ type: 'image', image_hash: first.hash });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/launcher/creative
router.post('/creative', async (req, res) => {
  try {
    const account = firstAdAccount();
    const { name, pageId, adCopy, ctaType, ctaUrl, mediaType, videoId, imageHash } = req.body;

    let objectStorySpec;
    if (mediaType === 'video') {
      objectStorySpec = {
        page_id: pageId,
        video_data: {
          video_id: videoId,
          message: adCopy,
          call_to_action: {
            type: ctaType,
            value: { link: ctaUrl },
          },
        },
      };
    } else {
      objectStorySpec = {
        page_id: pageId,
        link_data: {
          image_hash: imageHash,
          message: adCopy,
          link: ctaUrl,
          call_to_action: {
            type: ctaType,
            value: { link: ctaUrl },
          },
        },
      };
    }

    const r = await fetch(`${FB_API}/${account}/adcreatives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        object_story_spec: objectStorySpec,
        access_token: token(),
      }),
    });
    const json = await r.json();
    if (json.error) throw new Error(json.error.message);
    res.json({ creative_id: json.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
