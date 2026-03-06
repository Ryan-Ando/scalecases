// IndexedDB persistence layer for additive/cumulative data storage.
// Stores GHL contacts, FB daily insights, and FB ads across sessions.

const DB_NAME = 'scalecases_v1';
const DB_VERSION = 1;
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

export async function dbClearAll() {
  _db = null; // force re-open after clear
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onsuccess = e => {
      const db = e.target.result;
      const stores = ['ghlContacts', 'fbDailyInsights', 'fbAds', 'meta'];
      const tx = db.transaction(stores, 'readwrite');
      for (const s of stores) tx.objectStore(s).clear();
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = e => reject(e.target.error);
  });
}
