// Keeps this browser's stored data (IndexedDB stores + a few localStorage settings) in
// step with the server's shared state store (server/routes/state.js), so every device
// shows the same budgets, layouts, merge groups and accumulated ad data.
//
// - On app start `initialSync()` pulls what changed on the server and pushes anything
//   this device has that the server lacks, then the tabs mount from local storage as before.
// - Every local write (db.js hooks, lsSet) is queued and pushed in batches.
// - While the page is visible it checks the server once a minute; new data from another
//   device is applied locally and a "reload" badge is shown, since mounted tabs read their
//   data at mount time.

import { useSyncExternalStore } from 'react';
import { registerSyncHooks, raw } from './db.js';

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const IDB_STORES = ['ghlContacts', 'fbDailyInsights', 'fbAds', 'adDailyInsights', 'campaignTraining', 'campaignKpis', 'killSnapshots', 'meta'];
export const SETTINGS_KEYS = ['spend_pacing_v2', 'spendSheetColOrder', 'trackingColOrder', 'trackingAccountNames', 'hideCityAds',
  'reuseThresholdMonths', 'relaunchMinLeads', 'angleMatrix_angles', 'cpl_row_order', 'variations_saved_ads',
  'niche_budgets'];
const ALL_STORES = [...IDB_STORES, 'settings'];
const PUSH_DELAY = 1500;
const BATCH_BYTES = 4_000_000;
const POLL_MS = 60_000;

let status = { state: 'idle', pending: 0, lastSync: null, updates: false, error: '', persistent: true };
const listeners = new Set();
function publish(patch) { status = { ...status, ...patch }; listeners.forEach(fn => fn()); }
export function useSyncStatus() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => status);
}

function cursorKey(store) { return `sync_cursor:${store}`; }
function getCursor(store) { try { return JSON.parse(localStorage.getItem(cursorKey(store)) || 'null'); } catch { return null; } }
function setCursor(store, c) { localStorage.setItem(cursorKey(store), JSON.stringify(c)); }

async function api(path, opts = {}) {
  const res = await fetch(`${BASE}/api/state${path}`, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

// ── local read/apply helpers (bypass the push hooks) ─────────────────────────
async function readLocal(store) {
  if (store === 'settings') return SETTINGS_KEYS.filter(k => localStorage.getItem(k) != null).map(k => ({ id: k, value: localStorage.getItem(k) }));
  if (store === 'meta') return (await raw.getAllMeta()).map(([id, value]) => ({ id, value }));
  return raw.getAll(store);
}
async function applyRemote(store, records, reset) {
  if (reset) {
    if (store === 'settings') SETTINGS_KEYS.forEach(k => localStorage.removeItem(k));
    else await raw.clearStore(store);
  }
  const live = records.filter(r => !r._deleted).map(r => { const c = { ...r }; delete c._rev; delete c._deleted; return c; });
  const dead = records.filter(r => r._deleted).map(r => r.id);
  if (store === 'settings') {
    for (const r of live) localStorage.setItem(r.id, r.value);
    for (const id of dead) localStorage.removeItem(id);
  } else if (store === 'meta') {
    for (const r of live) await raw.setMeta(r.id, r.value);
    for (const id of dead) await raw.setMeta(id, null);
  } else {
    if (live.length) await raw.upsert(store, live);
    for (const id of dead) await raw.del(store, id);
  }
  return live.length + dead.length;
}

// ── push queue ───────────────────────────────────────────────────────────────
const queue = new Map();      // store -> { up: Map id->record, del: Set }
let pushTimer = null, pushing = false;
function q(store) { if (!queue.has(store)) queue.set(store, { up: new Map(), del: new Set() }); return queue.get(store); }
function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => void pushAll(), PUSH_DELAY); publish({ pending: countPending() }); }
function countPending() { let n = 0; for (const v of queue.values()) n += v.up.size + v.del.size; return n; }

export function queueUpsert(store, records) {
  const s = q(store);
  for (const r of records) { if (r?.id == null) continue; s.del.delete(String(r.id)); s.up.set(String(r.id), r); }
  schedulePush();
}
export function queueDelete(store, ids) {
  const s = q(store);
  for (const id of ids) { s.up.delete(String(id)); s.del.add(id); }
  schedulePush();
}
export async function clearRemote(store) {
  queue.delete(store);
  try { const r = await api(`/${store}`, { method: 'DELETE' }); setCursor(store, { epoch: r.epoch, rev: 0 }); }
  catch (e) { publish({ error: `Could not clear ${store} on the server: ${e.message}` }); }
}

async function pushStore(store) {
  const s = queue.get(store); if (!s) return;
  const cur = getCursor(store) || { epoch: null, rev: 0 };
  const ups = [...s.up.values()]; const dels = [...s.del]; s.up.clear(); s.del.clear();
  try {
    let batch = [], bytes = 0;
    const send = async () => { if (!batch.length) return; const r = await api(`/${store}`, { method: 'POST', body: { epoch: cur.epoch, records: batch } }); setCursor(store, { epoch: r.epoch, rev: r.rev }); batch = []; bytes = 0; };
    for (const r of ups) { const sz = JSON.stringify(r).length; if (bytes + sz > BATCH_BYTES && batch.length) await send(); batch.push(r); bytes += sz; }
    await send();
    if (dels.length) { const r = await api(`/${store}/delete`, { method: 'POST', body: { epoch: cur.epoch, ids: dels } }); setCursor(store, { epoch: r.epoch, rev: r.rev }); }
  } catch (e) {
    if (e.status === 409) {
      // another device cleared this store: drop our stale copy and take the server's
      await pullStore(store, true);
    } else {
      for (const r of ups) s.up.set(String(r.id), r); for (const id of dels) s.del.add(id);   // retry later
      throw e;
    }
  }
}

async function pushAll() {
  if (pushing) { schedulePush(); return; }
  pushing = true; publish({ state: 'syncing' });
  try {
    for (const store of [...queue.keys()]) await pushStore(store);
    publish({ state: 'synced', error: '', lastSync: new Date().toISOString() });
  } catch (e) { publish({ state: 'offline', error: e.message }); }
  finally { pushing = false; publish({ pending: countPending() }); if (countPending()) schedulePush(); }
}

// ── pull ─────────────────────────────────────────────────────────────────────
async function pullStore(store, force = false, serverInfo = null) {
  const cur = getCursor(store);
  if (!force && serverInfo && cur && serverInfo.epoch === cur.epoch && serverInfo.rev <= cur.rev) return 0;
  const since = cur ? cur.rev : 0;
  const r = await api(`/${store}?since=${since}${cur ? `&epoch=${cur.epoch}` : ''}`);
  const reset = r.reset || (cur && cur.epoch !== r.epoch);
  const n = await applyRemote(store, r.records, !!reset && !!cur);
  setCursor(store, { epoch: r.epoch, rev: r.rev });
  return n;
}

async function seedIfServerEmpty(store, serverInfo) {
  // First sync from a device that already holds data: push it only if the server has none
  // for this store. If the server already has the store, the server wins and this device's
  // old local copy is replaced (caches re-sync from Facebook anyway).
  if (getCursor(store)) return;
  if (serverInfo && serverInfo.count > 0) return;
  const local = await readLocal(store);
  if (local.length) queueUpsert(store, local);
}

export async function pullAll({ initial = false } = {}) {
  const idx = await api('');
  publish({ persistent: idx.persistent !== false });
  let changed = 0;
  for (const store of ALL_STORES) {
    const info = idx.stores[store] || null;
    if (initial) await seedIfServerEmpty(store, info);
    if (!info) { if (!getCursor(store)) setCursor(store, { epoch: 1, rev: 0 }); continue; }
    changed += await pullStore(store, false, info);
  }
  return changed;
}

let pollTimer = null;
export async function initialSync(timeoutMs = 8000) {
  publish({ state: 'syncing' });
  let timedOut = false;
  const work = (async () => {
    try {
      const changed = await pullAll({ initial: true });
      publish({ state: 'synced', error: '', lastSync: new Date().toISOString() });
      // tabs already mounted from the old local copy: offer a reload to show what arrived
      if (timedOut && changed > 0) publish({ updates: true });
    } catch (e) { publish({ state: 'offline', error: e.message }); }
  })();
  await Promise.race([work, new Promise(r => setTimeout(() => { timedOut = true; r(); }, timeoutMs))]);
  if (countPending()) schedulePush();
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.visibilityState !== 'visible' || pushing) return;
    try { const n = await pullAll(); if (n > 0) publish({ updates: true }); publish({ state: countPending() ? status.state : 'synced', error: '' }); }
    catch (e) { publish({ state: 'offline', error: e.message }); }
  }, POLL_MS);
}

// localStorage setter for synced settings; drop-in for localStorage.setItem(key, string)
export function lsSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* quota */ }
  if (SETTINGS_KEYS.includes(key)) queueUpsert('settings', [{ id: key, value }]);
}

registerSyncHooks({
  upsert: (store, records) => { if (IDB_STORES.includes(store)) queueUpsert(store, records); },
  setMeta: (key, value) => { if (value == null) queueDelete('meta', [key]); else queueUpsert('meta', [{ id: key, value }]); },
  del: (store, id) => { if (IDB_STORES.includes(store)) queueDelete(store, [id]); },
  clear: (store) => { if (IDB_STORES.includes(store)) void clearRemote(store); },
});

window.addEventListener('beforeunload', () => { if (countPending()) void pushAll(); });
