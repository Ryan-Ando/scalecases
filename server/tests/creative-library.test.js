import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanLibrary, startHelper } from '../../tools/creative-library/helper.mjs';
import { creativeKey, groupLibrary, prependUntested } from '../../client/src/creativeMatching.js';

test('state versions normalize without collapsing creative numbers or media variants', () => {
  for (const name of ['0901-Notes-1-img-LSSCA.png', '0901-Notes-1-CA LSS-img.png', '0901-Notes-1-img-LSS CO.PNG']) {
    assert.equal(creativeKey(name), creativeKey('0901-Notes-1-img'));
  }
  assert.notEqual(creativeKey('0901-Notes-1-img'), creativeKey('0901-Notes-2-img'));
  assert.notEqual(creativeKey('0901-Notes-1-img'), creativeKey('0901-Notes-1'));
  assert.notEqual(creativeKey('0901-Notes-1-CA LHP-img'), creativeKey('0901-Notes-1-img'));
  assert.match(creativeKey('0901-IG SC-1-img'), /ig sc/);
});
const file = (name, id = name) => ({ id, name, relativePath: `0901/${name}.png`, folder: '0901', date: '2026-09-01' });

test('actual firm and spelled-out state exports are excluded when the base ad ran', () => {
  const pairs = [
    ['0315-Notes Notif Bank-3-CA LHP-img', '0315-Notes Notif Bank-3-img'],
    ['0329-Reddit Comment PR-CA SL-img', '0329-Reddit Comment PR-img'],
    ['0323-GPT Chat-2-D.C.-img', '0323-GPT Chat-2-img'],
    ['0319-GptVid-3-Texas-UGC', '0319-GptVid-3-UGC'],
    ['0616-No Police Report PR-Iles BG-1-CA LSS', '0616-No Police Report PR-Iles BG-1-C'],
  ];
  for (const [local, used] of pairs) {
    assert.equal(groupLibrary([file(local)], [{ name: used }])[0].known, true, local);
  }
  assert.equal(groupLibrary([file('0315-Notes Notif Bank-4-img')], [{ name: pairs[0][1] }])[0].known, false);
});

test('unidentifiable exports cannot become new-ad recommendations', () => {
  const groups = groupLibrary([file('image'), file('311')], []);
  assert.equal(prependUntested([], groups, [{brand: 'LSS', state: 'TX', spend: 200, results: 1}], 'LSS', 'TX', true).length, 0);
});
test('manual merges and known inactive ads exclude every matching state version', () => {
  const files = [file('0901-Notes-1-img-LSSCA'), file('0901-Notes-1-img-LSS CO'), file('0910-Different name')];
  const groups = groupLibrary(files, [{ name: 'old name', status: 'ARCHIVED' }], [{ canonical: 'Main ad', members: ['old name', '0901-Notes-1-img', '0910-Different name'] }]);
  assert.equal(groups.length, 1); assert.equal(groups[0].known, true); assert.equal(groups[0].files.length, 3);
  assert.equal(groups[0].name, 'Main ad');
});
test('deleted creative groups stay hidden; generic and state-only duplicate files share a row', () => {
  const groups = groupLibrary([file('0901-Notes-1-img'), file('0901-Notes-1-img-LSS CO'), file('0902-Other')], [], [], new Set(['0902-Other']));
  assert.equal(groups.length, 1); assert.equal(groups[0].files.length, 2);
});
test('only a campaign below $300 gets untested ads; the existing list is otherwise unchanged', () => {
  const proven = [{ name: 'Proven', tier: 1 }];
  const library = [{ key: 'new', name: 'New', files: [], known: false }, { key: 'used', name: 'Used', files: [], known: true }];
  for (const spend of [3000, 3010]) {
    assert.equal(prependUntested(proven, library, [{ name: 'LSS TX', brand: 'LSS', state: 'TX', spend, results: 10 }], 'LSS', 'TX', true), proven);
  }
  const campaigns = [{ name: 'Cheap TX', brand: 'LSS', state: 'TX', spend: 2990, results: 10 }, { name: 'Expensive TX', brand: 'LSS', state: 'TX', spend: 6000, results: 10 }];
  const result = prependUntested(proven, library, campaigns, 'LSS', 'TX', true);
  assert.equal(result.length, 2); assert.equal(result[0].name, 'New'); assert.equal(result[1], proven[0]);
  assert.deepEqual(result[0].targets.map(t => t.name), ['Cheap TX']);
  assert.equal(prependUntested(proven, library, campaigns, 'LSS', 'TX', false), proven);
  assert.equal(prependUntested(proven, library, [{ ...campaigns[0], results: 0 }], 'LSS', 'TX', true), proven);
  assert.equal(prependUntested(proven, library, campaigns, 'Halo', 'TX', true), proven);
});

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'scalecases-library-'));
  const root = path.join(parent, '2026 B2C');
  await fs.mkdir(path.join(root, '0901'), { recursive: true });
  await fs.mkdir(path.join(root, 'CO'), { recursive: true });
  await fs.writeFile(path.join(root, '0901', '0901-Notes-1-img.png'), 'fake-image');
  await fs.writeFile(path.join(root, 'CO', '0901-Notes-1-img-LSS CO.png'), 'fake-variant');
  await fs.writeFile(path.join(root, '0901', 'voice.mp3'), 'ignore');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return root;
}
test('scanner handles date folders and state folders and ignores audio', async t => {
  const root = await fixture(t), result = await scanLibrary(root);
  assert.equal(result.files.length, 2);
  assert.equal(result.files[1].state, 'CO'); assert.equal(result.files[1].date, '2026-09-01');
  assert.equal(result.files.some(f => f.relativePath.includes(root)), false);
});
test('local helper restricts origins, exposes no arbitrary file path, and notices new files', async t => {
  const root = await fixture(t);
  const origin = 'https://scalecases-client.onrender.com';
  const helper = await startHelper({ root, port: 0, origins: [origin], intervalMs: 600_000 });
  t.after(() => helper.close());
  const base = `http://127.0.0.1:${helper.server.address().port}`;
  assert.equal((await fetch(`${base}/manifest`)).status, 403);
  assert.equal((await fetch(`${base}/manifest`, { headers: { Origin: 'https://other.example' } })).status, 403);
  const headers = { Origin: origin };
  const manifest = await (await fetch(`${base}/manifest`, { headers })).json();
  assert.equal(manifest.files.length, 2); assert.equal(manifest.error, null);
  assert.equal(await (await fetch(`${base}/preview/${manifest.files[0].id}`, { headers })).text(), 'fake-image');
  assert.equal((await fetch(`${base}/preview/../../config.json`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/manifest`, { method: 'POST', headers })).status, 405);
  await fs.writeFile(path.join(root, '0901', '0901-new.mp4'), 'video');
  await helper.scan();
  assert.equal((await (await fetch(`${base}/manifest`, { headers })).json()).files.length, 3);
});
