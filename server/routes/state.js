// Shared browser state: a small record-sync store so every device shows the same
// budgets, column layouts, merge groups and accumulated Facebook / GHL / sheet data.
//
// Each named store is a map id -> record. Every write bumps the store's `rev` and stamps
// the record with `_rev`; deletes leave a tombstone (`_deleted: true`). Clients pull with
// `?since=<rev>` to get only what changed, and push upserts/deletes in batches. Clearing a
// store bumps its `epoch`; a client whose epoch is older wipes its local copy and re-pulls.
//
// Files live under DATA_DIR/state/<store>.json. On Render, DATA_DIR must be a persistent
// disk mount, otherwise the data is lost on every deploy.

import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || './data';
const DIR = path.join(DATA_DIR, 'state');
const NAME_RE = /^[A-Za-z0-9_]{1,40}$/;
const stores = new Map();           // name -> { epoch, rev, updatedAt, records: Map }
const dirty = new Map();            // name -> flush timer

function file(name) { return path.join(DIR, `${name}.json`); }

function load(name) {
  if (stores.has(name)) return stores.get(name);
  let s = { epoch: 1, rev: 0, updatedAt: null, records: new Map() };
  try {
    const raw = JSON.parse(fs.readFileSync(file(name), 'utf8'));
    s = { epoch: raw.epoch || 1, rev: raw.rev || 0, updatedAt: raw.updatedAt || null, records: new Map(Object.entries(raw.records || {})) };
  } catch { /* new store */ }
  stores.set(name, s);
  return s;
}

function flush(name) {
  const s = stores.get(name);
  if (!s) return;
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ epoch: s.epoch, rev: s.rev, updatedAt: s.updatedAt, records: Object.fromEntries(s.records) }));
  fs.renameSync(tmp, file(name));
}

function scheduleFlush(name) {
  clearTimeout(dirty.get(name));
  dirty.set(name, setTimeout(() => { dirty.delete(name); try { flush(name); } catch (e) { console.error('state flush failed', name, e.message); } }, 1000));
}

function flushAll() {
  for (const name of dirty.keys()) { clearTimeout(dirty.get(name)); try { flush(name); } catch { /* best effort */ } }
  dirty.clear();
}
process.once('SIGTERM', () => { flushAll(); process.exit(0); });
process.once('SIGINT', () => { flushAll(); process.exit(0); });

function storeParam(req, res) {
  const name = req.params.store;
  if (!NAME_RE.test(name)) { res.status(400).json({ error: 'invalid store name' }); return null; }
  return load(name);
}

// GET /api/state — index of all stores
router.get('/', (_req, res) => {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* ignore */ }
  const names = new Set(stores.keys());
  try { for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json')) names.add(f.slice(0, -5)); } catch { /* none yet */ }
  const out = {};
  for (const n of names) { if (!NAME_RE.test(n)) continue; const s = load(n); out[n] = { epoch: s.epoch, rev: s.rev, updatedAt: s.updatedAt, count: [...s.records.values()].filter(r => !r._deleted).length }; }
  res.json({ stores: out, persistent: !!process.env.DATA_DIR });
});

// GET /api/state/:store?since=<rev>&epoch=<epoch> — changes since rev (all live records when the epoch differs)
router.get('/:store', (req, res) => {
  const s = storeParam(req, res); if (!s) return;
  const since = parseInt(req.query.since, 10) || 0;
  const epoch = req.query.epoch == null ? null : parseInt(req.query.epoch, 10);
  const reset = epoch != null && epoch !== s.epoch;
  const records = [];
  for (const r of s.records.values()) {
    if (reset) { if (!r._deleted) records.push(r); }
    else if (r._rev > since) records.push(r);
  }
  res.json({ epoch: s.epoch, rev: s.rev, reset, records });
});

// POST /api/state/:store — { epoch?, records: [{id, ...}] } upsert
router.post('/:store', (req, res) => {
  const s = storeParam(req, res); if (!s) return;
  const { epoch, records } = req.body || {};
  if (epoch != null && epoch !== s.epoch) return res.status(409).json({ error: 'epoch mismatch', epoch: s.epoch, rev: s.rev });
  if (!Array.isArray(records)) return res.status(400).json({ error: 'records must be an array' });
  let n = 0;
  for (const r of records) {
    const id = r?.id;
    if (id == null || (typeof id !== 'string' && typeof id !== 'number')) continue;
    const { _rev, _deleted, ...rest } = r;
    s.records.set(String(id), { ...rest, id, _rev: ++s.rev });
    n++;
  }
  if (n) { s.updatedAt = new Date().toISOString(); scheduleFlush(req.params.store); }
  res.json({ ok: true, epoch: s.epoch, rev: s.rev, upserted: n });
});

// POST /api/state/:store/delete — { epoch?, ids: [] } tombstones
router.post('/:store/delete', (req, res) => {
  const s = storeParam(req, res); if (!s) return;
  const { epoch, ids } = req.body || {};
  if (epoch != null && epoch !== s.epoch) return res.status(409).json({ error: 'epoch mismatch', epoch: s.epoch, rev: s.rev });
  let n = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const cur = s.records.get(String(id));
    if (!cur || cur._deleted) continue;       // nothing to delete: no tombstone needed
    s.records.set(String(id), { id: cur.id, _deleted: true, _rev: ++s.rev });
    n++;
  }
  if (n) { s.updatedAt = new Date().toISOString(); scheduleFlush(req.params.store); }
  res.json({ ok: true, epoch: s.epoch, rev: s.rev, deleted: n });
});

// DELETE /api/state/:store — clear; other devices wipe their copy on next pull
router.delete('/:store', (req, res) => {
  const s = storeParam(req, res); if (!s) return;
  s.epoch += 1; s.rev = 0; s.records = new Map(); s.updatedAt = new Date().toISOString();
  scheduleFlush(req.params.store);
  res.json({ ok: true, epoch: s.epoch, rev: s.rev });
});

export default router;
