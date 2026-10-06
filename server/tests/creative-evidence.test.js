import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../routes/facebook.js', import.meta.url), 'utf8');
function harness(failed = [], historyFailed = failed) {
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
    fetchInsightsRaw: async (level) => { calls++; if (level === 'ad') return Object.assign([{ad_id: 'historic', ad_name: 'Removed but delivered'}], {failedAccounts: historyFailed}); return Object.assign([{ campaign_id: 'campaign', campaign_name: 'LSS TX', spend: '2990', actions: [] }], { failedAccounts: failed }); },
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
  assert.equal(data.inventory.ads.length, 4);
  assert.equal(data.campaigns.rows[0].spend / data.campaigns.rows[0].results, 299);
  assert.equal(Date.parse(data.until) - Date.parse(data.since), 29 * 86400000);
  await h.request();
  assert.equal(h.calls, 3);
});

test('an account cooldown leaves both evidence checks incomplete', async () => {
  const data = await harness(['account']).request();
  assert.equal(data.inventory.complete, false);
  assert.equal(data.campaigns.complete, false);
  assert.equal(data.inventory.failedAccounts[0], 'account');
});


test('complete current inventory cannot qualify ads when historical delivery is incomplete', async () => {
  const data = await harness([], ['historical-account']).request();
  assert.equal(data.inventory.complete, false);
  assert.equal(data.inventory.historyComplete, false);
  assert.equal(data.campaigns.complete, true);
});
