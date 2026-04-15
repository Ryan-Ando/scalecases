import { Router } from 'express';
import fetch from 'node-fetch';

const router = Router();

function makeToken(password) {
  return Buffer.from(`scalecases:${password}`).toString('base64');
}

// POST /api/auth/login  { password }
router.post('/login', (req, res) => {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return res.json({ ok: true, token: 'open' }); // no password set = open access
  const { password } = req.body;
  if (!password || password !== expected) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.json({ ok: true, token: makeToken(expected) });
});

// GET /api/auth/verify  Authorization: Bearer <token>
router.get('/verify', (req, res) => {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return res.json({ ok: true }); // no password set = open access
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  res.json({ ok: token === makeToken(expected) });
});

// ── Facebook OAuth (for Meta App Review — demonstrates ads_read permission grant) ──

// GET /api/auth/facebook  →  redirects user to Meta OAuth consent screen
router.get('/facebook', (req, res) => {
  const appId       = process.env.FB_APP_ID;
  const redirectUri = process.env.FB_REDIRECT_URI;
  if (!appId || !redirectUri) {
    return res.status(500).send('FB_APP_ID or FB_REDIRECT_URI not configured in .env');
  }
  const params = new URLSearchParams({
    client_id:     appId,
    redirect_uri:  redirectUri,
    scope:         'ads_read',
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

// GET /api/auth/facebook/callback  →  exchanges code for token, redirects back to client
router.get('/facebook/callback', async (req, res) => {
  const { code, error } = req.query;
  const clientUrl  = process.env.CLIENT_URL || 'http://localhost:5173';

  if (error || !code) {
    return res.redirect(`${clientUrl}/?fb_error=1`);
  }

  try {
    const params = new URLSearchParams({
      client_id:     process.env.FB_APP_ID,
      client_secret: process.env.FB_APP_SECRET,
      redirect_uri:  process.env.FB_REDIRECT_URI,
      code,
    });
    const r    = await fetch(`https://graph.facebook.com/v19.0/oauth/access_token?${params}`);
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    // Token is intentionally not persisted — this flow exists to satisfy Meta App Review.
    // The app uses a system user token (FB_ACCESS_TOKEN in .env) for all actual API calls.
    res.redirect(`${clientUrl}/?fb_connected=1`);
  } catch (err) {
    console.error('FB OAuth callback error:', err.message);
    res.redirect(`${clientUrl}/?fb_error=1`);
  }
});

export default router;
