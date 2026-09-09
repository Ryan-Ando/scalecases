import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../routes/facebook.js', import.meta.url), 'utf8');
function queueHarness({ failFirst = false } = {}) {
  let now = 1000, cooling = false;
  const calls = [];
  const context = vm.createContext({
    Date: { now: () => now }, Promise,
    setTimeout: fn => { now += 100; fn(); },
    FB_CALL_GAP_MS: 100, FB_PROXY_AGENT: null,
    _stats: { callCount: 0, errors: 0 },
    assertAccountAvailable: () => { if (cooling) throw Error('cooldown'); },
    captureRateLimit: () => {},
    fbError: () => Error('rate limit'),
    noteAccountError: () => { cooling = true; },
    fetch: async () => {
      calls.push(now);
      return { headers: {}, json: async () => failFirst ? { error: {} } : {} };
    },
  });
  vm.runInContext(source.slice(source.indexOf('const _fbQueue = []'), source.indexOf('const _stats = {')), context);
  return { calls, context, request: () => vm.runInContext('fbFetch("url", "account", "primary")', context) };
}
test('spacing survives an empty queue between sequential pages', async () => {
  const h = queueHarness();
  await h.request(); await h.request();
  assert.equal(h.calls[1] - h.calls[0], 100);
  assert.equal(h.context._stats.callCount, 2);
});
test('a throttle stops queued pages before another network request', async () => {
  const h = queueHarness({ failFirst: true });
  const results = await Promise.allSettled([h.request(), h.request()]);
  assert.equal(h.calls.length, 1);
  assert.equal(results[0].status, 'rejected');
  assert.match(results[1].reason.message, /cooldown/);
  assert.equal(h.context._stats.errors, 1);
});
function cacheHarness(prior) {
  const cache = new Map(prior ? [['key', { data: prior }]] : []);
  const context = vm.createContext({
    _cache: cache, _rewarms: new Map(), clearTimeout,
    cacheGetStale: key => cache.has(key) ? { data: cache.get(key).data, ageMinutes: 180 } : null,
    cacheSet: (key, data) => cache.set(key, { data }),
    adAccounts: () => ['affected'],
  });
  vm.runInContext(source.slice(source.indexOf('function cachePartialAware('), source.indexOf('// Coalesce')), context);
  return { cache, put(data, failed) { context.data = data; context.failed = failed; return vm.runInContext('cachePartialAware("key", data, failed)', context); } };
}
test('equal-length missing insights cannot overwrite the last good snapshot', () => {
  const prior = [{ id: 'a', results: 20 }];
  const h = cacheHarness(prior);
  const partial = [{ id: 'a', results: 0 }]; partial.failedAccounts = ['affected'];
  const result = h.put(partial, true);
  assert.equal(result[0].results, 20);
  assert.equal(result.staleAgeMinutes, 180);
  assert.equal(result.failedAccounts[0], 'affected');
  assert.equal(h.cache.get('key').data, prior);
});
test('cold partial data stays identified and a complete refresh replaces it', () => {
  const h = cacheHarness();
  h.put([], true);
  assert.equal(h.cache.get('key').partial, true);
  const fresh = [{ id: 'a', results: 7 }];
  h.put(fresh, false);
  assert.equal(h.cache.get('key').data, fresh);
  assert.equal(h.cache.get('key').partial, undefined);
});
test('concurrent shared downloads execute once and can retry after rejection', async () => {
  const ctx = vm.createContext({ Promise, Map });
  const start = source.indexOf('const _inflight = new Map();');
  vm.runInContext(source.slice(start, source.indexOf('//', start)), ctx);
  let calls = 0;
  ctx.work = async () => { calls++; throw Error('temporary'); };
  await Promise.allSettled([vm.runInContext('dedupInflight("list", work)', ctx), vm.runInContext('dedupInflight("list", work)', ctx)]);
  assert.equal(calls, 1);
  ctx.work = async () => { calls++; return []; };
  await vm.runInContext('dedupInflight("list", work)', ctx);
  assert.equal(calls, 2);
});

test('an app cooldown encountered during pagination is not retried as a transient failure', async () => {
  let calls = 0, retries = 0;
  const message = '[act_758516163121709] APP-WIDE rate-limit cooldown (15m left) ? call skipped';
  const ctx = vm.createContext({
    URLSearchParams, FB_API: 'https://example.invalid', INSIGHTS_FIELDS: 'spend',
    FB_INSIGHTS_PAGE_SIZE: 500, tokenFor: () => 'test',
    assertAccountAvailable: () => {},
    fbFetch: async () => { calls++; throw Error(message); },
    console: { warn: () => {} },
    setTimeout: fn => { retries++; fn(); },
  });
  vm.runInContext(source.match(/const RATE_LIMIT_RE = .*;/)[0], ctx);
  vm.runInContext(source.match(/function isRateLimitError\(e\) \{[^\n]+/)[0], ctx);
  const start = source.indexOf('async function fetchInsightsForAccount(');
  const end = source.indexOf('// Fetch insights from all accounts', start);
  vm.runInContext(source.slice(start, end), ctx);
  await assert.rejects(vm.runInContext('fetchInsightsForAccount("act_758516163121709", "ad", "maximum", {}, null, "primary")', ctx), /call skipped/);
  assert.equal(calls, 1);
  assert.equal(retries, 0);
  ctx.error = Error('An unknown error occurred');
  assert.equal(vm.runInContext('isRateLimitError(error)', ctx), false);
});
