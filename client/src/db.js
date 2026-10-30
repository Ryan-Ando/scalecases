// IndexedDB persistence layer for additive/cumulative data storage.
// Stores GHL contacts, FB daily insights, and FB ads across sessions.

const DB_NAME = 'scalecases_v1';
const DB_VERSION = 6; // v6 adds killSnapshots store
let _db = null;

// Sync hooks (registered by sync.js). Public writers call them after a successful local
// write; the `raw` accessors below bypass them so remote changes can be applied silently.
let hooks = { upsert() {}, setMeta() {}, del() {}, clear() {} };
export function registerSyncHooks(h) { hooks = { ...hooks, ...h }; }

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('ghlContacts')) {
        db.createObjectStore('ghlContacts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fbDailyInsights')) {
        db.createObjectStore('fbDailyInsights', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('fbAds')) {
        db.createObjectStore('fbAds', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
      // v2: manual sheet import store
      if (!db.objectStoreNames.contains('sheetImport')) {
        db.createObjectStore('sheetImport', { keyPath: 'id' });
      }
      // v3: ad-level daily insights (selectively synced per ad)
      if (!db.objectStoreNames.contains('adDailyInsights')) {
        db.createObjectStore('adDailyInsights', { keyPath: 'id' });
      }
      // v4: AI training notes per campaign
      if (!db.objectStoreNames.contains('campaignTraining')) {
        db.createObjectStore('campaignTraining', { keyPath: 'id' });
      }
      // v5: per-campaign KPI settings (keyed by campaign id)
      if (!db.objectStoreNames.contains('campaignKpis')) {
        db.createObjectStore('campaignKpis', { keyPath: 'id' });
      }
      // v6: saved CSV exports for kill analysis (snapshots over time)
      if (!db.objectStoreNames.contains('killSnapshots')) {
        db.createObjectStore('killSnapshots', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked — close other tabs of this site and reload.'));
  });
}

export async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putAll(storeName, records) {
  if (!records.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const r of records) store.put(r);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbUpsert(storeName, records) {
  await putAll(storeName, records);
  if (records.length) hooks.upsert(storeName, records);
}

export async function dbGetMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function putMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbSetMeta(key, value) {
  await putMeta(key, value);
  hooks.setMeta(key, value);
}

async function getAllMeta() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const store = tx.objectStore('meta');
    const keysReq = store.getAllKeys(); const valsReq = store.getAll();
    tx.oncomplete = () => resolve(keysReq.result.map((k, i) => [k, valsReq.result[i]]));
    tx.onerror = () => reject(tx.error);
  });
}

async function delOne(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbDelete(storeName, id) {
  await delOne(storeName, id);
  hooks.del(storeName, id);
}

async function clearOne(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbClearStore(storeName) {
  await clearOne(storeName);
  hooks.clear(storeName);
}

// Hook-free accessors used by sync.js to apply changes that came from the server.
export const raw = { getAll: dbGetAll, getAllMeta, upsert: putAll, setMeta: putMeta, del: delOne, clearStore: clearOne };

// Clears sync data but preserves fbAds (ad structure) and sheet import.
// fbAds is kept because it maps adset IDs → ad names → campaign states, which
// GHL lead matching depends on. Losing it after a rate-limited re-sync causes
// state columns and lead counts to disappear. Only insights/metrics need wiping.
// Pass clearImport=true to also wipe the sheet import.
export async function dbClearAll(clearImport = false) {
  _db = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => {
      const db = e.target.result;
      // 'meta' and 'fbAds' intentionally excluded — meta holds user-authored AI rules,
      // fbAds holds ad structure needed for GHL lead mapping.
      const stores = ['ghlContacts', 'fbDailyInsights', 'adDailyInsights'];
      if (clearImport) stores.push('sheetImport');
      const tx = db.transaction(stores, 'readwrite');
      for (const s of stores) tx.objectStore(s).clear();
      tx.oncomplete = () => { db.close(); for (const s of stores) hooks.clear(s); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = e => reject(e.target.error);
  });
}
