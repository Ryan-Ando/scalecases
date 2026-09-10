import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSpendSchedule, monthWindow, easternDate } from '../spendSchedule.js';
const silent = { log() {}, error() {}, warn() {} };
test('month window includes every completed day, excluding today and future months', () => {
  assert.deepEqual(monthWindow(2026, 8, '2026-09-10'), { start: '2026-09-01', end: '2026-09-09' });
  assert.deepEqual(monthWindow(2026, 7, '2026-09-10'), { start: '2026-08-01', end: '2026-08-31' });
  assert.equal(monthWindow(2026, 9, '2026-09-10'), null);
  assert.equal(monthWindow(2026, 8, '2026-09-01'), null);
  assert.deepEqual(monthWindow(2024, 1, '2024-03-01'), { start: '2024-02-01', end: '2024-02-29' });
});
test('runs after 06:15 Eastern and does not repeat after restart', async () => {
  let date = new Date('2026-09-10T10:14:00Z'), calls = 0, checkpoint;
  const options = { now: () => date, log: silent, save: s => { checkpoint = { ...s }; }, push: async () => { calls++; return { updated: 100 }; } };
  const scheduler = createSpendSchedule(options);
  await scheduler.tick(); assert.equal(calls, 0);
  date = new Date('2026-09-10T10:20:00Z');
  await scheduler.tick(); await scheduler.tick(); assert.equal(calls, 1);
  await createSpendSchedule({ ...options, load: () => checkpoint }).tick();
  assert.equal(calls, 1);
});
test('failed export retries after 65 minutes and cannot overlap', async () => {
  let date = new Date('2026-09-10T11:00:00Z'), calls = 0;
  const scheduler = createSpendSchedule({ now: () => date, log: silent, push: async () => { calls++; throw Error('incomplete'); } });
  await Promise.all([scheduler.tick(), scheduler.tick()]); assert.equal(calls, 1);
  await scheduler.tick(); assert.equal(calls, 1);
  date = new Date('2026-09-10T12:05:00Z');
  await scheduler.tick(); assert.equal(calls, 2);
  assert.equal(scheduler.status().lastSuccessDate, null);
});
test('first day finishes previous month and winter schedule uses Eastern standard time', async () => {
  let target;
  const scheduler = createSpendSchedule({ now: () => new Date('2027-01-01T11:15:00Z'), log: silent, push: async args => { target = args; return { updated: 1 }; } });
  await scheduler.tick(); assert.deepEqual(target, { year: 2026, monthIndex: 11 });
});
const source = fs.readFileSync(new URL('../routes/sheets.js', import.meta.url), 'utf8');
function sheetHarness(failed = false) {
  const writes = [], requests = [];
  const rows = [{ campaign_name: 'LSS TX', date_start: '2026-09-01', spend: '10' }, { campaign_name: 'LSS TX', date_start: '2026-09-09', spend: '25' }];
  rows.failedAccounts = failed ? ['act_missing'] : [];
  const ctx = vm.createContext({
    console: silent, Date, Intl, monthWindow, easternDate: () => '2026-09-10',
    process: { env: { SPEND_SHEET_ID: 'test', FB_AD_ACCOUNTS: 'act_test' } },
    getAuthClient: async () => ({}),
    fetchDailyInsights: async args => { requests.push(args); return rows; },
    whopDailyCampaignRows: async () => [],
    google: { sheets: () => ({ spreadsheets: {
      get: async () => ({ data: { sheets: [{ properties: { title: 'September 2026' } }] } }),
      values: {
        get: async () => ({ data: { values: [['Date', 'TX', 'GA'], ...Array.from({ length: 30 }, (_, i) => [String(i + 1)])] } }),
        batchUpdate: async args => { writes.push(args); return { data: {} }; },
      },
    } }) },
  });
  vm.runInContext(source.slice(source.indexOf('const US_STATES'), source.indexOf('// GET /api/sheets/spend-tabs')), ctx);
  return { writes, requests, run: () => vm.runInContext('pushSpendToSheet({year: 2026, monthIndex: 8})', ctx) };
}
test('writes the entire month through yesterday, never today or future rows', async () => {
  const h = sheetHarness(); await h.run();
  assert.equal(h.requests[0].start, '2026-09-01'); assert.equal(h.requests[0].end, '2026-09-09');
  const updates = h.writes[0].requestBody.data;
  assert.equal(updates.length, 18);
  assert.equal(updates.find(u => u.range.endsWith('B2')).values[0][0], 10);
  assert.equal(updates.find(u => u.range.endsWith('B10')).values[0][0], 25);
  assert.equal(updates.some(u => /[A-Z]+11$/.test(u.range)), false);
});
test('incomplete Facebook results prevent all Google Sheet writes', async () => {
  const h = sheetHarness(true);
  await assert.rejects(h.run(), /incomplete Facebook data/);
  assert.equal(h.writes.length, 0);
});

test('configured Whop failure blocks strict sheet export instead of returning empty spend', async () => {
  const whopSource = fs.readFileSync(new URL('../routes/whop.js', import.meta.url), 'utf8');
  const start = whopSource.indexOf('export async function whopDailyCampaignRows(');
  const end = whopSource.indexOf('// Cursor-paginated', start);
  const ctx = vm.createContext({ whopEnabled: () => true, whopReport: async () => { throw Error('Whop unavailable'); }, console: silent });
  vm.runInContext(whopSource.slice(start, end).replace('export async', 'async'), ctx);
  await assert.rejects(vm.runInContext('whopDailyCampaignRows("2026-09-01", "2026-09-09", {strict: true})', ctx), /Whop unavailable/);
  assert.equal((await vm.runInContext('whopDailyCampaignRows("2026-09-01", "2026-09-09")', ctx)).length, 0);
});
