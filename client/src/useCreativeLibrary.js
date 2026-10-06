import { useSyncExternalStore, useEffect } from 'react';
import { dbGetMeta, dbSetMeta } from './db.js';

export const LOCAL_LIBRARY_URL = 'http://127.0.0.1:43127';
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const listeners = new Set();
let state = { files: [], scannedAt: null, connected: false, loading: false, error: '', evidence: null, evidenceError: '', previews: false };
let inFlight, evidenceFlight, lastEvidence = 0, users = 0, timer;
function publish(patch) { state = { ...state, ...patch }; listeners.forEach(fn => fn()); }
async function refreshEvidence() {
  if (evidenceFlight) return evidenceFlight;
  if (Date.now() - lastEvidence < 5 * 60_000) return;
  evidenceFlight = (async () => {
    try {
      const response = await fetch(`${BASE}/api/facebook/creative-evidence`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Facebook inventory unavailable');
      const saved = await dbGetMeta('creativeSeenAds') || [];
      const seen = new Map(saved.map(a => [JSON.stringify([a.id, a.name]), a]));
      for (const ad of data.inventory.ads) seen.set(JSON.stringify([ad.id, ad.name]), ad);
      data.inventory.ads = [...seen.values()];
      await dbSetMeta('creativeSeenAds', data.inventory.ads);
      lastEvidence = Date.now();
      publish({ evidence: data, evidenceError: '' });
    } catch (error) { publish({ evidenceError: error.message, evidence: null }); }
  })().finally(() => { evidenceFlight = null; });
  return evidenceFlight;
}
export function refreshLibrary() {
  if (inFlight) return inFlight;
  publish({ loading: true });
  inFlight = (async () => {
    try {
      const response = await fetch(`${LOCAL_LIBRARY_URL}/manifest`, { signal: AbortSignal.timeout(5000), targetAddressSpace: 'loopback' });
      if (!response.ok) throw new Error('Local helper refused the connection');
      const data = await response.json();
      if (data.version !== 1 || !Array.isArray(data.files)) throw new Error('Update the local creative helper');
      publish({ files: data.files, scannedAt: data.scannedAt, connected: !data.error, error: data.error || '' });
      if (!data.error) void refreshEvidence();
    } catch {
      publish({ connected: false, error: 'Local folder unavailable. Use this computer with the helper running and allow local-network access in your browser.' });
    } finally { publish({ loading: false }); }
  })().finally(() => { inFlight = null; });
  return inFlight;
}
export function enableLocalPreviews() { publish({ previews: !state.previews }); }
export function useCreativeLibrary() {
  const snapshot = useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
  useEffect(() => {
    users++;
    if (users === 1) {
      void refreshLibrary();
      timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshLibrary(); }, 60_000);
    }
    return () => { if (--users === 0) clearInterval(timer); };
  }, []);
  return snapshot;
}
