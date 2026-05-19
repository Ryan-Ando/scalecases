// Server-side storage for Kill Analysis snapshots.
// Snapshots are JSON files written under DATA_DIR/snapshots/.
// On Render, DATA_DIR should be set to a persistent disk mount path; otherwise
// the default ./data is ephemeral and resets on redeploy.

import express from 'express';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

const DATA_DIR = process.env.DATA_DIR || './data';
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');

async function ensureDir() {
  await fs.mkdir(SNAP_DIR, { recursive: true });
}

function safeId(id) {
  // strict allowlist — IDs must look like snap_<timestamp>_<short>
  return /^snap_[A-Za-z0-9_]+$/.test(id) ? id : null;
}

// GET /api/snapshots — list all snapshots (full data; this is the source of truth)
router.get('/', async (_req, res) => {
  try {
    await ensureDir();
    const files = await fs.readdir(SNAP_DIR);
    const snaps = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const text = await fs.readFile(path.join(SNAP_DIR, f), 'utf8');
        snaps.push(JSON.parse(text));
      } catch { /* skip unreadable */ }
    }
    res.json({ snapshots: snaps });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/snapshots — accepts { snapshots: [...] } and writes each as a file
router.post('/', async (req, res) => {
  try {
    await ensureDir();
    const list = Array.isArray(req.body?.snapshots) ? req.body.snapshots : [];
    let written = 0;
    for (const snap of list) {
      const id = safeId(snap?.id);
      if (!id) continue;
      const file = path.join(SNAP_DIR, `${id}.json`);
      await fs.writeFile(file, JSON.stringify(snap), 'utf8');
      written++;
    }
    res.json({ ok: true, written });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/snapshots/:id — delete one
router.delete('/:id', async (req, res) => {
  try {
    const id = safeId(req.params.id);
    if (!id) return res.status(400).json({ error: 'invalid id' });
    await fs.unlink(path.join(SNAP_DIR, `${id}.json`)).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/snapshots — clear all
router.delete('/', async (_req, res) => {
  try {
    await ensureDir();
    const files = await fs.readdir(SNAP_DIR);
    let removed = 0;
    for (const f of files) {
      if (f.endsWith('.json')) {
        await fs.unlink(path.join(SNAP_DIR, f)).catch(() => {});
        removed++;
      }
    }
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
