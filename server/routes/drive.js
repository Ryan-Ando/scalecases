// The creative library straight from Google Drive, for when no local Scale Cases Helper is
// running (a phone, the partner's laptop before setup, any browser). Reads the Shared Drive
// "ScaleCases Cloud" with the server's Google service account (GOOGLE_SERVICE_ACCOUNT_JSON, the
// one the Sheets push uses), read-only. Same API and file ids as the helper (library_helper.py):
//   GET /api/drive/manifest      the library's media files
//   GET /api/drive/preview/:id   one file, with Range support for video
//   GET /api/drive/status        which service account, which drive, how many files, last error
// Setup: add the service account's email (shown by /status) to the Shared Drive as a Viewer, and
// enable the Google Drive API in its Google Cloud project.

import { Router } from 'express';
import crypto from 'crypto';
import { google } from 'googleapis';

const router = Router();
const DRIVE_NAME = process.env.LIBRARY_SHARED_DRIVE || 'ScaleCases Cloud';
const RESCAN_MS = 5 * 60_000;
const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
const FOLDER = 'application/vnd.google-apps.folder';

let lib = { files: [], byId: new Map(), library: '', scannedAt: null, error: null, at: 0 };
let scanning = null;

function credentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set on the server');
  return JSON.parse(raw);
}
let client = null;
function drive() {
  if (!client) {
    const auth = new google.auth.GoogleAuth({ credentials: credentials(), scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
    client = google.drive({ version: 'v3', auth });
  }
  return client;
}
const extOf = name => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase() : ''; };

// Mirrors scan_library() in tools/disclaimer-worker/library_helper.py (same ids and fields)
export function buildManifest(libraryName, entries) {
  const year = parseInt((libraryName.match(/20\d{2}/) || [])[0], 10);
  const files = [], byId = new Map();
  for (const e of entries) {
    const ext = extOf(e.name);
    if (!TYPES[ext] || e.name.startsWith('.') || e.folders.some(f => f.startsWith('.'))) continue;
    const rel = [...e.folders, e.name].join('/');
    const state = e.folders.map(f => f.toUpperCase()).find(f => STATES.has(f)) || null;
    const code = e.folders.map(f => f.match(/^(\d{4})(?:\D|$)/)?.[1]).find(Boolean) || e.name.match(/^(\d{4})(?:\D|$)/)?.[1] || null;
    let date = null;
    if (code && year) {
      const m = parseInt(code.slice(0, 2), 10), d = parseInt(code.slice(2), 10);
      const dt = new Date(Date.UTC(year, m - 1, d));
      if (dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) date = dt.toISOString().slice(0, 10);
    }
    const id = crypto.createHash('sha256').update(rel, 'utf8').digest('hex').slice(0, 24);
    files.push({ id, name: e.name.slice(0, -ext.length), relativePath: rel, folder: e.folders.join('/'), date, state,
      kind: TYPES[ext].startsWith('image/') ? 'image' : 'video' });
    byId.set(id, { driveId: e.id, type: TYPES[ext], size: Number(e.size) || 0, name: e.name });
  }
  files.sort((a, b) => (a.relativePath.toLowerCase() < b.relativePath.toLowerCase() ? -1 : 1));
  return { files, byId };
}

async function scan() {
  const d = drive();
  const drives = [];
  let pageToken;
  do {
    const r = await d.drives.list({ pageSize: 100, pageToken });
    drives.push(...(r.data.drives || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  const shared = drives.find(x => x.name === DRIVE_NAME);
  if (!shared) throw new Error(`The service account ${credentials().client_email} is not a member of the Shared Drive "${DRIVE_NAME}". Add it as a Viewer.`);

  const items = [];
  pageToken = undefined;
  do {
    const r = await d.files.list({
      corpora: 'drive', driveId: shared.id, includeItemsFromAllDrives: true, supportsAllDrives: true,
      q: 'trashed = false', fields: 'nextPageToken, files(id, name, mimeType, parents, size)', pageSize: 1000, pageToken,
    });
    items.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);

  const children = new Map();
  for (const it of items) for (const p of it.parents || []) {
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(it);
  }
  // The newest "20xx B2C" folder at the top of the drive, as the helper picks it
  const roots = (children.get(shared.id) || []).filter(it => it.mimeType === FOLDER && /^20\d{2}.*B2C$/i.test(it.name))
    .sort((a, b) => b.name.localeCompare(a.name));
  if (!roots.length) throw new Error(`No "20xx B2C" folder at the top of the Shared Drive "${DRIVE_NAME}"`);
  const root = roots[0];
  const entries = [];
  const walk = (folderId, folders, depth) => {
    if (depth > 20) return;
    for (const it of children.get(folderId) || []) {
      if (it.mimeType === FOLDER) walk(it.id, [...folders, it.name], depth + 1);
      else entries.push({ id: it.id, name: it.name, size: it.size, folders });
    }
  };
  walk(root.id, [], 0);
  const { files, byId } = buildManifest(root.name, entries);
  lib = { files, byId, library: root.name, scannedAt: new Date().toISOString(), error: null, at: Date.now() };
}

// Rescans at most every 5 minutes, only when asked; keeps serving the last good scan on errors
function ensureFresh() {
  if (Date.now() - lib.at < RESCAN_MS) return Promise.resolve();
  if (!scanning) scanning = scan().catch(e => { lib = { ...lib, error: e.message, at: Date.now() - RESCAN_MS + 60_000 }; })
    .finally(() => { scanning = null; });
  return lib.files.length ? Promise.resolve() : scanning;   // first scan: wait for it
}

// For the AdManage upload: a readable stream of one library file
export async function libraryFile(id) {
  await ensureFresh();
  const f = lib.byId.get(id);
  if (!f) throw new Error('That file is not in the Drive library (it may still be uploading to Drive)');
  const r = await drive().files.get({ fileId: f.driveId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' });
  return { stream: r.data, size: f.size, name: f.name, type: f.type };
}

router.get('/manifest', async (_req, res) => {
  await ensureFresh();
  res.set('Cache-Control', 'no-store');
  res.json({ version: 1, source: 'cloud', library: lib.library, scannedAt: lib.scannedAt,
    error: lib.files.length ? null : lib.error || 'Drive library not scanned yet', files: lib.files });
});

router.get('/preview/:id', async (req, res) => {
  try {
    await ensureFresh();
    const f = lib.byId.get(req.params.id);
    if (!f) return res.status(404).end();
    const headers = req.headers.range ? { Range: req.headers.range } : {};
    const r = await drive().files.get({ fileId: f.driveId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream', headers });
    res.status(r.status === 206 ? 206 : 200);
    res.set({ 'Content-Type': f.type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    for (const h of ['content-length', 'content-range']) if (r.headers[h]) res.set(h, r.headers[h]);
    r.data.on('error', () => res.destroy());
    r.data.pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(e.code === 416 ? 416 : 502).json({ error: e.message });
  }
});

router.get('/status', async (_req, res) => {
  let email = null;
  try { email = credentials().client_email; } catch (e) { return res.json({ ok: false, error: e.message }); }
  await ensureFresh();
  res.json({ ok: !!lib.files.length && !lib.error, email, sharedDrive: DRIVE_NAME, library: lib.library, files: lib.files.length,
    scannedAt: lib.scannedAt, error: lib.error });
});

export default router;
