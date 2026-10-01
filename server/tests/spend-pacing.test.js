import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../client/src/SpendSheet.jsx', import.meta.url), 'utf8');
test('disabled pacing skips calculations and returns no values for totals', () => {
  const ctx = vm.createContext({
    useMemo: fn => fn(), pacingStates: ['LSS TX'],
    pacing: { 'LSS TX': { enabled: false, startDate: '2026-09-01', endDate: '2026-09-30' } },
    pacingSpend: { 'LSS TX': 100 }, budgetByState: { 'LSS TX': 50 },
    monthsBetween: () => ['2026-09'], daysLeft: () => { throw Error('disabled calculation ran'); },
  });
  const start = source.indexOf('  const pacingRows = useMemo(');
  const end = source.indexOf('// Default the tab name', start);
  vm.runInContext(source.slice(start, end) + '\nthis.result = pacingRows;', ctx);
  for (const field of ['totalBudget', 'daysLeft', 'spentToDate', 'remaining', 'dailyNeeded', 'liveBudget', 'shortfall']) assert.equal(ctx.result[0][field], null);
});
test('manual and detected rows share one brand/state key', () => {
  const ctx = vm.createContext({
    useMemo: fn => fn(), budgetStates: ['LSS TX'], pacing: { 'LSS TX': { enabled: false } },
    insights: [{ campaign_name: 'LSS TX' }, { campaign_name: 'Halo TX' }], extractGroup: name => name,
  });
  const start = source.indexOf('  const pacingStates = useMemo(');
  vm.runInContext(source.slice(start, source.indexOf('  const pacingRows', start)) + '\nthis.result = pacingStates;', ctx);
  assert.deepEqual(Array.from(ctx.result), ['Halo TX', 'LSS TX']);
});
test('spend uses each enabled row start date without cross-window double counting', async () => {
  let result; const requests = [];
  const ctx = vm.createContext({
    BASE: '', Date, pacingRequest: { current: 0 }, pacing: {
      'LSS TX': { startDate: '2026-09-01' },
      'Halo GA': { startDate: '2026-09-10' },
      'LSS AL': { startDate: '2026-08-01', enabled: false },
    },
    extractGroup: name => name, setPacingError: () => {}, setPacingLoading: () => {},
    setPacingSpend: data => { result = data; }, setPacingSpendDetail: () => {},
    fetch: async url => { requests.push(url); return { ok: true, json: async () => [
      { campaign_name: 'LSS TX', spend: 100 }, { campaign_name: 'Halo GA', spend: 50 }, { campaign_name: 'LSS AL', spend: 80 },
    ] }; },
  });
  const start = source.indexOf('  async function fetchPacingSpend()');
  vm.runInContext(source.slice(start, source.indexOf('  const budgetByState', start)), ctx);
  await vm.runInContext('fetchPacingSpend()', ctx);
  assert.equal(requests.length, 2);
  assert.equal(result['LSS TX'], 100); assert.equal(result['Halo GA'], 50);
  assert.equal(result['LSS AL'], undefined);
});

test('pacing automatically refreshes for enabled start-date changes, not budget edits', () => {
  let dependencies, timer, cancelled, cleared = false, loads = 0;
  const ctx = vm.createContext({
    pacing: { 'LSS TX': { startDate: '2026-10-01', monthlyBudgets: { '2026-10': 5000 } } },
    pacingRequest: { current: 0 }, setPacingSpend: () => {}, setPacingSpendDetail: () => {},
    setPacingError: () => {}, setPacingLoading: () => {},
    useEffect: (fn, deps) => { dependencies = deps; cancelled = fn(); },
    setTimeout: fn => { timer = fn; return 1; }, clearTimeout: () => { cleared = true; },
    fetchPacingSpend: () => { loads++; },
  });
  const start = source.indexOf('  const pacingSpendKey =');
  const code = source.slice(start, source.indexOf('  async function fetchPacingSpend()', start));
  vm.runInContext('{'+code+'}', ctx);
  const original = dependencies[0]; timer(); assert.equal(loads, 1);
  cancelled(); assert.equal(cleared, true); assert.equal(ctx.pacingRequest.current, 1);
  ctx.pacing['LSS TX'].monthlyBudgets['2026-10'] = 6000;
  vm.runInContext('{'+code+'}', ctx); assert.equal(dependencies[0], original);
  ctx.pacing['LSS TX'].startDate = '2026-09-01';
  vm.runInContext('{'+code+'}', ctx); assert.notEqual(dependencies[0], original);
});
test('partial spend cannot become a zero-spend pacing calculation', async () => {
  let saved = false, error;
  const ctx = vm.createContext({
    BASE: '', Date, pacingRequest: { current: 0 }, pacing: { 'LSS TX': { startDate: '2026-10-01' } },
    setPacingLoading: () => {}, setPacingError: value => { error = value; },
    setPacingSpend: () => { saved = true; }, setPacingSpendDetail: () => {},
    fetch: async () => ({ ok: true, headers: { get: () => 'act_missing' }, json: async () => [] }),
  });
  const start = source.indexOf('  async function fetchPacingSpend()');
  vm.runInContext(source.slice(start, source.indexOf('  const budgetByState', start)), ctx);
  await vm.runInContext('fetchPacingSpend()', ctx);
  assert.equal(saved, false); assert.match(error, /incomplete or stale/);
});
