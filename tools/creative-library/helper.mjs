import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime' };
const STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
export async function scanLibrary(root) {
  const base = await fs.promises.realpath(root);
  const year = Number(path.basename(base).match(/20\d{2}/)?.[0]);
  if (!year) throw new Error('The library folder must include its year, such as 2026 B2C.');
  const files = [], paths = new Map();
  async function visit(dir) {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(full); continue; }
      const ext = path.extname(entry.name).toLowerCase();
      if (!entry.isFile() || !TYPES[ext]) continue;
      const relativePath = path.relative(base, full).split(path.sep).join('/');
      const parts = relativePath.split('/');
      const state = parts.slice(0, -1).map(p => p.toUpperCase()).find(p => STATES.has(p)) || null;
      const dateCode = parts.slice(0, -1).map(p => p.match(/^(\d{4})(?:\D|$)/)?.[1]).find(Boolean)
        || entry.name.match(/^(\d{4})(?:\D|$)/)?.[1];
      let date = null;
      if (dateCode) {
        const candidate = `${year}-${dateCode.slice(0, 2)}-${dateCode.slice(2)}`;
        const parsed = new Date(candidate + 'T12:00:00Z');
        if (!isNaN(parsed) && parsed.toISOString().slice(0, 10) === candidate) date = candidate;
      }
      const id = crypto.createHash('sha256').update(relativePath).digest('hex').slice(0, 24);
      files.push({ id, name: entry.name.slice(0, -ext.length), relativePath, folder: parts.slice(0, -1).join('/'), date, state, kind: TYPES[ext].startsWith('image/') ? 'image' : 'video' });
      paths.set(id, { full, type: TYPES[ext] });
    }
  }
  await visit(base);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { base, files, paths };
}

export async function startHelper({ root, port = 43127, origins = ['https://scalecases-client.onrender.com'], intervalMs = 60_000 }) {
  let library, error = null, scannedAt = null, scanning = null;
  async function scan() {
    if (scanning) return scanning;
    scanning = (async () => {
      try { library = await scanLibrary(root); scannedAt = new Date().toISOString(); error = null; }
      catch (e) { error = e.message; }
    })().finally(() => { scanning = null; });
    return scanning;
  }
  await scan();
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!origins.includes(origin) || req.headers.host !== `127.0.0.1:${server.address().port}`) {
      res.writeHead(403); res.end('Not allowed'); return;
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (req.url === '/manifest') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version: 1, library: path.basename(root), scannedAt, error, files: library?.files || [] }));
      return;
    }
    const id = req.url?.match(/^\/preview\/([a-f0-9]{24})$/)?.[1];
    const file = library?.paths.get(id);
    if (!file) { res.writeHead(404); res.end(); return; }
    try {
      // Recheck the resolved target: a file/directory may have become a link since scanning.
      const resolved = await fs.promises.realpath(file.full);
      const relative = path.relative(library.base, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Outside library');
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) throw new Error('Not a file');
      let start = 0, end = stat.size - 1;
      if (req.headers.range) {
        const match = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
        if (!match) { res.writeHead(416); res.end(); return; }
        start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= stat.size) { res.writeHead(416); res.end(); return; }
        res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', file.type);
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      const stream = fs.createReadStream(resolved, { start, end });
      stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const timer = setInterval(scan, intervalMs); timer.unref();
  return { server, scan, close: () => { clearInterval(timer); return new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const configPath = process.argv[process.argv.indexOf('--config') + 1];
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  startHelper(config).then(() => console.log('Scale Cases local library ready')).catch(e => { console.error(e.message); process.exitCode = 1; });
}
