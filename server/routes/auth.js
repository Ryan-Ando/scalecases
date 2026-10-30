// App-password authentication for internal staff (APP_PASSWORD).
// All Meta Marketing API calls use a System User Access Token (FB_ACCESS_TOKEN)
// configured in Business Manager — no end-user Facebook Login flow exists.

import { Router } from 'express';
import crypto from 'crypto';

const router = Router();

// One-way, so the token kept in the browser doesn't reveal the password.
// Changing APP_PASSWORD signs every browser out.
function makeToken(password) {
  return crypto.createHmac('sha256', password).update('scalecases-login').digest('hex');
}

function tokenOk(req) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return true; // no password set = open access
  const got = crypto.createHash('sha256').update((req.headers.authorization || '').replace('Bearer ', '')).digest();
  return crypto.timingSafeEqual(got, crypto.createHash('sha256').update(makeToken(expected)).digest());
}

// Calls from outside a browser can't log in; they keep working without the token
const PUBLIC = ['/auth/', '/digest/telegram', '/hyros/webhook'];

// Mounted on /api: every route needs the login token once APP_PASSWORD is set
export function requireLogin(req, res, next) {
  if (PUBLIC.some(p => req.path === p || req.path.startsWith(p))) return next();
  if (tokenOk(req)) return next();
  res.status(401).json({ error: 'Not logged in', login: true });
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
  res.json({ ok: tokenOk(req) });
});

export default router;
