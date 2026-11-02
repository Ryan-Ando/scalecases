import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildManifest } from '../routes/drive.js';
import { requireLogin } from '../routes/auth.js';

test('Drive manifest matches the helper: ids, state, date, kind, skipped files', () => {
  const { files, byId } = buildManifest('2026 B2C', [
    { id: 'd1', name: '0424-Pixar Car PR-2-ai - lss co.mp4', size: '10', folders: ['CO', 'new disclaimer', '0424'] },
    { id: 'd2', name: '0315-Notes-3-img.png', size: '5', folders: ['0315'] },
    { id: 'd3', name: 'notes.txt', size: '1', folders: [] },
    { id: 'd4', name: '.hidden.mp4', size: '1', folders: [] },
    { id: 'd5', name: '0230-Bad Date.jpg', size: '1', folders: [] },
  ]);
  assert.equal(files.length, 3);
  const co = files.find(f => f.state === 'CO');
  assert.equal(co.id, crypto.createHash('sha256').update('CO/new disclaimer/0424/0424-Pixar Car PR-2-ai - lss co.mp4').digest('hex').slice(0, 24));
  assert.deepEqual({ ...co, id: undefined }, { id: undefined, name: '0424-Pixar Car PR-2-ai - lss co', relativePath: 'CO/new disclaimer/0424/0424-Pixar Car PR-2-ai - lss co.mp4',
    folder: 'CO/new disclaimer/0424', date: '2026-04-24', state: 'CO', kind: 'video' });
  assert.equal(files.find(f => f.name === '0315-Notes-3-img').date, '2026-03-15');
  assert.equal(files.find(f => f.name === '0230-Bad Date').date, null);
  assert.equal(byId.get(co.id).driveId, 'd1');
});

test('the login token in the URL is accepted only for Drive previews', () => {
  const prev = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'pw';
  const token = crypto.createHmac('sha256', 'pw').update('scalecases-login').digest('hex');
  const run = (path, query) => { let ok = false, code = 200;
    requireLogin({ baseUrl: '/api', path, query, headers: {} }, { status: c => { code = c; return { json: () => {} }; } }, () => { ok = true; });
    return ok || code; };
  assert.equal(run('/drive/preview/abc', { token }), true);
  assert.equal(run('/drive/preview/abc', { token: 'nope' }), 401);
  assert.equal(run('/facebook/ads', { token }), 401);
  process.env.APP_PASSWORD = prev;
});
