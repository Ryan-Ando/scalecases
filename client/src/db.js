// IndexedDB persistence layer for additive/cumulative data storage.
// Stores GHL contacts, FB daily insights, and FB ads across sessions.

const DB_NAME = 'scalecases_v1';
const DB_VERSION = 5; // v5 adds campaignKpis store
let _db = null;

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
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror = e => reject(e.target.error);
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

export async function dbUpsert(storeName, records) {
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

export async function dbGetMeta(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function dbSetMeta(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbDelete(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function dbClearStore(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// Clears sync data (GHL contacts, FB data, meta) but preserves sheet import.
// Pass clearImport=true to also wipe the sheet import.
export async function dbClearAll(clearImport = false) {
  _db = null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => {
      const db = e.target.result;
      const stores = ['ghlContacts', 'fbDailyInsights', 'fbAds', 'adDailyInsights', 'meta'];
      if (clearImport) stores.push('sheetImport');
      const tx = db.transaction(stores, 'readwrite');
      for (const s of stores) tx.objectStore(s).clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = e => reject(e.target.error);
  });
}
