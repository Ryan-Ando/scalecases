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
    BASE: '', Date, pacing: {
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
