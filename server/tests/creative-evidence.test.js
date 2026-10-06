import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../routes/facebook.js', import.meta.url), 'utf8');
function harness(failed = []) {
  let handler, calls = 0;
  const cache = new Map();
  const context = vm.createContext({
    router: { get: (_path, fn) => { handler = fn; } },
    adAccounts: () => ['account'], Date, Map, Number, Promise, CACHE_TTL: 7200000,
    isoDateOffset: (day, offset) => new Date(Date.parse(day) + offset * 86400000).toISOString().slice(0, 10),
    dedupInflight: (_key, fn) => fn(),
    cacheGet: key => cache.get(key), cacheGetStale: () => ({ data: { ads: [{ id: 'old', name: 'Previously seen' }] } }),
    cacheSet: (key, data) => cache.set(key, data),
    fetchFromAllAccounts: async () => { calls++; return Object.assign([{ id: 'new', name: 'Inactive creative' }], { failedAccounts: failed }); },
    fetchInsightsRaw: async () => { calls++; return Object.assign([{ campaign_id: 'campaign', campaign_name: 'LSS TX', spend: '2990', actions: [] }], { failedAccounts: failed }); },
    extractResults: () => ({ results: 10 }),
  });
  const start = source.indexOf("router.get('/creative-evidence'");
  vm.runInContext(source.slice(start, source.indexOf('// GET /api/facebook/campaign-spend', start)), context);
  return { get calls() { return calls; }, async request() { let result; await handler({}, { json: value => { result = value; }, status() { return this; } }); return result; } };
}

test('creative evidence retains prior matches and reuses cached Facebook reads', async () => {
  const h = harness();
  const data = await h.request();
  assert.equal(data.inventory.complete, true);
  assert.equal(data.inventory.ads.length, 2);
  assert.equal(data.campaigns.rows[0].spend / data.campaigns.rows[0].results, 299);
  assert.equal(Date.parse(data.until) - Date.parse(data.since), 29 * 86400000);
  await h.request();
  assert.equal(h.calls, 2);
});

test('an account cooldown leaves both evidence checks incomplete', async () => {
  const data = await harness(['account']).request();
  assert.equal(data.inventory.complete, false);
  assert.equal(data.campaigns.complete, false);
  assert.equal(data.inventory.failedAccounts[0], 'account');
});
