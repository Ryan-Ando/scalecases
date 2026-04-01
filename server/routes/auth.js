import { Router } from 'express';

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

export default router;
